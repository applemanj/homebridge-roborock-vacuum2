import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import RoborockPlatform from "./platform";
import { getLiveMessageForThisAccessory } from "./live_message";

const { stateCodes } = require("../roborockLib/lib/deviceFeatures");

const MAX_HOMEKIT_NAME_LENGTH = 64;
const FALLBACK_SCENE_NAME = "Roborock Scene";
const SCHEDULE_SERVICE_PREFIX = "roborock-schedule-";
const SCHEDULE_UPDATE_VERIFY_DELAY_MS = 1500;
const CLEANING_STATES = new Set([4, 5, 6, 7, 11, 15, 16, 17, 18, 23, 26]);

export interface RoborockSchedule {
  id: string;
  enabled: boolean;
  timer: unknown[];
}

export function parseServerTimers(value: unknown): RoborockSchedule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const schedules = new Map<string, RoborockSchedule>();
  for (const timer of value) {
    if (!Array.isArray(timer) || timer.length < 2) {
      continue;
    }

    const [rawId, rawStatus] = timer;
    if (
      (typeof rawId !== "string" && typeof rawId !== "number") ||
      (rawStatus !== "on" && rawStatus !== "off")
    ) {
      continue;
    }

    const id = String(rawId);
    if (id && !schedules.has(id)) {
      schedules.set(id, {
        id,
        enabled: rawStatus === "on",
        timer: [...timer],
      });
    }
  }

  return [...schedules.values()];
}

export function toHomeKitSafeName(
  name: string | null | undefined,
  fallback = FALLBACK_SCENE_NAME
): string {
  const sanitized = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ']+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "")
    .trim()
    .slice(0, MAX_HOMEKIT_NAME_LENGTH)
    .replace(/[^A-Za-z0-9]+$/, "")
    .trim();

  return sanitized || fallback;
}

/**
 * An instance of this class is created for each accessory the platform registers.
 * Each accessory may expose multiple services of different service types.
 */
export default class RoborockVacuumAccessory {
  private services: Service[] = [];
  private sceneServices: Map<string, Service> = new Map();
  private scheduleServices: Map<string, Service> = new Map();
  private scheduleWriteInProgress: Set<string> = new Set();
  private scheduleWriteSuppression: Map<
    string,
    { enabled: boolean; timestamp: number }
  > = new Map();
  private controlSwitches: Map<string, Service> = new Map();
  private currentScenes: any[] = [];
  private currentSchedules: Map<string, RoborockSchedule> = new Map();
  private lastKnownBatteryLevel: number | null = null;

  constructor(
    private readonly platform: RoborockPlatform,
    private readonly accessory: PlatformAccessory
  ) {
    // Accessory Information
    // https://developers.homebridge.io/#/service/AccessoryInformation
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.platform.roborockAPI.getProductAttribute(
          accessory.context,
          "model"
        ) || "Unknown"
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.platform.roborockAPI.getVacuumDeviceInfo(
          accessory.context,
          "sn"
        ) || "Unknown"
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        this.platform.roborockAPI.getVacuumDeviceInfo(
          accessory.context,
          "fv"
        ) || "Unknown"
      );

    this.services["Fan"] =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    // This is what is displayed as the default name on the Home app
    this.services["Fan"].setCharacteristic(
      this.platform.Characteristic.Name,
      this.platform.roborockAPI.getVacuumDeviceInfo(
        accessory.context,
        "name"
      ) || "Roborock Vacuum"
    );

    this.services["Fan"]
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.setupControlSwitches();

    this.services["Battery"] =
      this.accessory.getService(this.platform.Service.Battery) ||
      this.accessory.addService(this.platform.Service.Battery);
    this.services["Fan"].addLinkedService(this.services["Battery"]);

    // Initialize dynamic switches.
    this.updateSceneSwitches();
    void this.updateScheduleSwitches();
    this.lastKnownBatteryLevel = this.getNormalizedBatteryLevel(
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "battery"
      ),
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "charge_status"
      ),
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "state"
      )
    );

    this.updateBatteryCharacteristics(
      this.lastKnownBatteryLevel,
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "charge_status"
      ),
      this.platform.roborockAPI.getVacuumDeviceStatus(
        accessory.context,
        "state"
      )
    );
  }

  /**
   * Add explicit action switches for commands that should not be bundled into
   * the primary HomeKit on/off control.
   */
  private setupControlSwitches() {
    this.setupMomentaryControlSwitch(
      "pause-cleaning",
      "Pause Cleaning",
      this.setPauseCleaning.bind(this)
    );

    this.setupMomentaryControlSwitch(
      "return-to-dock",
      "Return to Dock",
      this.setReturnToDock.bind(this)
    );
  }

  private setupMomentaryControlSwitch(
    key: string,
    displayName: string,
    onSet: (value: CharacteristicValue) => Promise<void>
  ) {
    const switchService =
      this.accessory.getServiceById(this.platform.Service.Switch, key) ||
      this.accessory.addService(this.platform.Service.Switch, displayName, key);

    switchService.setCharacteristic(
      this.platform.Characteristic.Name,
      displayName
    );

    switchService.addOptionalCharacteristic(
      this.platform.Characteristic.ConfiguredName
    );
    switchService.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      displayName
    );

    switchService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(onSet)
      .onGet(this.getMomentaryControlSwitch.bind(this));

    this.controlSwitches.set(key, switchService);
  }

  private resetMomentaryControlSwitch(key: string) {
    setTimeout(() => {
      const service = this.controlSwitches.get(key);
      if (service) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }, 1000);
  }

  private getVacuumName(): string {
    return (
      this.platform.roborockAPI.getVacuumDeviceInfo(
        this.accessory.context,
        "name"
      ) || "Roborock vacuum"
    );
  }

  public getDuid(): string {
    const context = this.accessory.context as unknown;
    if (context && typeof context === "object" && "duid" in context) {
      return String((context as { duid: unknown }).duid);
    }

    return String(context);
  }

  async getMomentaryControlSwitch(): Promise<CharacteristicValue> {
    return false;
  }

  async setPauseCleaning(value: CharacteristicValue) {
    if (!value) {
      return;
    }

    const vacuumName = this.getVacuumName();
    await this.executeMomentaryVacuumAction(
      "pause-cleaning",
      `Pausing ${vacuumName}.`,
      "pause command",
      (error) => `Error pausing ${vacuumName}: ${error}`,
      () =>
        this.platform.roborockAPI.app_pause(this.accessory.context, {
          waitForResult: true,
        })
    );
  }

  async setReturnToDock(value: CharacteristicValue) {
    if (!value) {
      return;
    }

    const vacuumName = this.getVacuumName();
    await this.executeMomentaryVacuumAction(
      "return-to-dock",
      `Sending ${vacuumName} back to dock.`,
      "return to dock command",
      (error) => `Error sending ${vacuumName} back to dock: ${error}`,
      () =>
        this.platform.roborockAPI.app_charge(this.accessory.context, {
          waitForResult: true,
        })
    );
  }

  /**
   * Shared implementation for momentary command switches (pause, return to
   * dock): logs the start, times the acknowledgement, logs errors, and always
   * resets the momentary switch afterwards.
   */
  private async executeMomentaryVacuumAction(
    switchKey: string,
    startMessage: string,
    ackLabel: string,
    errorMessage: (error: unknown) => string,
    apiCall: () => Promise<void>
  ): Promise<void> {
    const vacuumName = this.getVacuumName();
    try {
      this.platform.log.info(startMessage);
      const startedAt = Date.now();
      await apiCall();
      this.platform.log.info(
        `HomeKit ${ackLabel} for ${vacuumName} was acknowledged by Roborock in ${Date.now() - startedAt} ms.`
      );
    } catch (error) {
      this.platform.log.error(errorMessage(error));
    } finally {
      this.resetMomentaryControlSwitch(switchKey);
    }
  }

  updateDeviceState() {
    try {
      this.services["Fan"].updateCharacteristic(
        this.platform.Characteristic.Active,
        this.platform.roborockAPI.isCleaning(
          this.platform.roborockAPI.getVacuumDeviceStatus(
            this.accessory.context,
            "state"
          )
        )
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE
      );

      this.updateBatteryCharacteristics(
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "battery"
        ),
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "charge_status"
        ),
        this.platform.roborockAPI.getVacuumDeviceStatus(
          this.accessory.context,
          "state"
        )
      );

      this.platform.log.debug(
        "Device state is " +
          this.state_code_to_state(
            this.platform.roborockAPI.getVacuumDeviceStatus(
              this.accessory.context,
              "state"
            )
          )
      );
    } catch (e) {
      this.platform.log.error("Error updating device state: " + e);
    }
  }

  /**
   * Update scene switches based on available scenes for this device
   */
  updateSceneSwitches() {
    try {
      // Get scenes for this device
      const deviceScenes = this.platform.roborockAPI.getScenesForDevice(
        this.accessory.context
      );

      // Check if scenes have changed
      if (this.scenesChanged(deviceScenes)) {
        this.platform.log.debug(
          `Updating scene switches for device ${this.accessory.context}`
        );

        // Remove existing scene switches that are no longer available

        // Add new scene switches
        for (const scene of deviceScenes) {
          try {
            const sceneId = scene.id.toString();
            const sceneName = toHomeKitSafeName(scene.name);
            if (!this.sceneServices.has(sceneId) && scene.enabled) {
              this.platform.log.debug(
                `Adding scene switch for: ${scene.name} (ID: ${sceneId})`
              );

              const switchService =
                this.accessory.getServiceById(
                  this.platform.Service.Switch,
                  `scene-${sceneId}`
                ) ||
                this.accessory.addService(
                  this.platform.Service.Switch,
                  sceneName,
                  `scene-${sceneId}`
                );

              switchService.setCharacteristic(
                this.platform.Characteristic.Name,
                sceneName
              );

              switchService.addOptionalCharacteristic(
                this.platform.Characteristic.ConfiguredName
              );
              switchService.setCharacteristic(
                this.platform.Characteristic.ConfiguredName,
                sceneName
              );

              switchService
                .getCharacteristic(this.platform.Characteristic.On)
                .onSet(this.setSceneSwitch.bind(this, sceneId))
                .onGet(this.getSceneSwitch.bind(this, sceneId));

              this.sceneServices.set(sceneId, switchService);
            }
          } catch (e) {
            this.platform.log.error(
              `Error processing scene ${scene.name}: ${e}`
            );
          }
        }

        //Remove scene switches that are no longer available
        this.accessory.services.forEach((service) => {
          if (
            service instanceof this.platform.Service.Switch &&
            service.UUID.startsWith("scene-")
          ) {
            const sceneId = service.UUID.replace("scene-", "");

            // Check if the scene id in deviceScenes
            if (
              !deviceScenes.some((scene) => scene.id.toString() === sceneId)
            ) {
              this.platform.log.debug(
                `Removing scene switch for: ${service.displayName} (ID: ${sceneId})`
              );
              this.accessory.removeService(service);
              this.sceneServices.delete(sceneId);
            }
          }
        });

        // Update current scenes
        this.currentScenes = deviceScenes;
      }
    } catch (error) {
      this.platform.log.error(`Error updating scene switches: ${error}`);
    }
  }

  /**
   * Check if scenes have changed
   */
  private scenesChanged(newScenes: any[]): boolean {
    const nextScenes = Array.isArray(newScenes) ? newScenes : [];

    if (this.currentScenes.length !== nextScenes.length) {
      return true;
    }

    const currentIds = this.currentScenes.map((scene) => scene.id).sort();
    const newIds = nextScenes.map((scene) => scene.id).sort();

    return JSON.stringify(currentIds) !== JSON.stringify(newIds);
  }

  async updateScheduleSwitches(): Promise<void> {
    try {
      const schedules = parseServerTimers(
        await this.platform.roborockAPI.getServerTimers(this.accessory.context)
      );
      this.syncScheduleSwitches(schedules);
    } catch (error) {
      this.platform.log.debug(
        `Unable to update schedule switches for ${this.getVacuumName()}: ${error}`
      );
    }
  }

  private syncScheduleSwitches(schedules: RoborockSchedule[]): void {
    const currentIds = new Set(schedules.map((schedule) => schedule.id));

    schedules.forEach((schedule, index) => {
      const serviceSubtype = this.getScheduleServiceSubtype(schedule.id);
      const displayName = `Roborock Schedule ${index + 1} (${schedule.id})`;
      let switchService = this.scheduleServices.get(schedule.id);

      if (!switchService) {
        switchService =
          this.accessory.getServiceById(
            this.platform.Service.Switch,
            serviceSubtype
          ) ||
          this.accessory.addService(
            this.platform.Service.Switch,
            displayName,
            serviceSubtype
          );

        switchService
          .getCharacteristic(this.platform.Characteristic.On)
          .onSet(this.setScheduleSwitch.bind(this, schedule.id))
          .onGet(this.getScheduleSwitch.bind(this, schedule.id));
        this.scheduleServices.set(schedule.id, switchService);
      }

      switchService.setCharacteristic(
        this.platform.Characteristic.Name,
        displayName
      );
      switchService.addOptionalCharacteristic(
        this.platform.Characteristic.ConfiguredName
      );
      switchService.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        displayName
      );
      switchService.updateCharacteristic(
        this.platform.Characteristic.On,
        schedule.enabled
      );
    });

    for (const [scheduleId, service] of this.scheduleServices) {
      if (!currentIds.has(scheduleId)) {
        this.accessory.removeService(service);
        this.scheduleServices.delete(scheduleId);
      }
    }

    for (const service of [...this.accessory.services]) {
      if (
        service.subtype?.startsWith(SCHEDULE_SERVICE_PREFIX) &&
        !schedules.some(
          (schedule) =>
            this.getScheduleServiceSubtype(schedule.id) === service.subtype
        )
      ) {
        this.accessory.removeService(service);
      }
    }

    this.currentSchedules = new Map(
      schedules.map((schedule) => [schedule.id, schedule])
    );
  }

  private getScheduleServiceSubtype(scheduleId: string): string {
    return `${SCHEDULE_SERVICE_PREFIX}${encodeURIComponent(scheduleId)}`;
  }

  private getUpdatedScheduleTimer(scheduleId: string, enabled: boolean): unknown[] {
    const existing = this.currentSchedules.get(scheduleId);
    if (existing && Array.isArray(existing.timer)) {
      const updatedTimer = [...existing.timer];
      if (updatedTimer.length > 1) {
        updatedTimer[1] = enabled ? "on" : "off";
      }
      return updatedTimer;
    }
    return [scheduleId, enabled ? "on" : "off"];
  }

  async setScheduleSwitch(
    scheduleId: string,
    value: CharacteristicValue
  ): Promise<void> {
const enabled = Boolean(value);

const now = Date.now();
const previousWrite = this.scheduleWriteSuppression.get(scheduleId);

// HomeKit/Matter can echo the same successful write back to the setter.
// Ignore an identical write for a short period, but allow a genuine
// state change immediately.
if (
  previousWrite &&
  previousWrite.enabled === enabled &&
  now - previousWrite.timestamp < 5000
) {
  this.platform.log.debug(
    `Ignoring duplicate HomeKit write for Roborock schedule ${scheduleId}: ` +
      `${enabled ? "enable" : "disable"}`
  );

  return;
}

// HomeKit may also issue overlapping writes while the first request is
// still in flight.
if (this.scheduleWriteInProgress.has(scheduleId)) {
  this.platform.log.debug(
    `Ignoring overlapping HomeKit write for Roborock schedule ${scheduleId}.`
  );

  return;
}

this.scheduleWriteInProgress.add(scheduleId);

    try {
      this.platform.log.info(
        `Updating Roborock schedule ${scheduleId}: ${
          enabled ? "enable" : "disable"
        }`
      );

      await this.platform.roborockAPI.updateServerTimer(
        this.accessory.context,
        this.getUpdatedScheduleTimer(scheduleId, enabled),
        enabled
      );

      const schedules = parseServerTimers(
        await this.platform.roborockAPI.getServerTimers(
          this.accessory.context
        )
      );

      this.currentSchedules = new Map(
        schedules.map((schedule) => [schedule.id, schedule])
      );

      const actual = this.currentSchedules.get(scheduleId)?.enabled;

      this.platform.log.info(
        `After upd_server_timer, Roborock schedule ${scheduleId} reports enabled=${actual}`
      );

      if (actual !== enabled) {
        this.platform.log.warn(
          `Roborock schedule ${scheduleId} did not change. ` +
            `Requested ${enabled ? "enabled" : "disabled"}, actual=${actual}.`
        );

        return;
      }

      const existingTimer =
        this.currentSchedules.get(scheduleId)?.timer ?? [
          scheduleId,
          enabled ? "on" : "off",
          1,
        ];

      this.currentSchedules.set(scheduleId, {
        id: scheduleId,
        enabled,
        timer: existingTimer,
      });

this.scheduleWriteSuppression.set(scheduleId, {
  enabled,
  timestamp: Date.now(),
});

this.platform.log.info(
  `${enabled ? "Enabled" : "Disabled"} Roborock schedule ${scheduleId}.`
);
    } catch (error) {
      this.platform.log.error(
        `Unable to ${enabled ? "enable" : "disable"} Roborock schedule ${scheduleId}: ${error}`
      );

      return;
    } finally {
      this.scheduleWriteInProgress.delete(scheduleId);
    }
  }

  async getScheduleSwitch(scheduleId: string): Promise<CharacteristicValue> {
    try {
      const schedules = parseServerTimers(
        await this.platform.roborockAPI.getServerTimers(this.accessory.context)
      );
      this.currentSchedules = new Map(
        schedules.map((schedule) => [schedule.id, schedule])
      );
      return this.currentSchedules.get(scheduleId)?.enabled ?? false;
    } catch (error) {
      this.platform.log.debug(
        `Unable to refresh Roborock schedule ${scheduleId}: ${error}`
      );
      return this.currentSchedules.get(scheduleId)?.enabled ?? false;
    }
  }

  private async verifyScheduleSwitch(
    scheduleId: string,
    enabled: boolean
  ): Promise<boolean> {
    await new Promise((resolve) =>
      setTimeout(resolve, SCHEDULE_UPDATE_VERIFY_DELAY_MS)
    );
    const schedules = parseServerTimers(
      await this.platform.roborockAPI.getServerTimers(this.accessory.context)
    );
    this.currentSchedules = new Map(
      schedules.map((schedule) => [schedule.id, schedule])
    );
    return this.currentSchedules.get(scheduleId)?.enabled === enabled;
  }

  /**
   * Handle scene switch activation
   */
  async setSceneSwitch(sceneId: string, value: CharacteristicValue) {
    try {
      this.platform.log.debug(`Scene switch ${sceneId} set to: ${value}`);

      if (value) {
        // Execute the scene
        await this.platform.roborockAPI.executeScene({ val: sceneId });
        this.platform.log.info(`Executed scene ID: ${sceneId}`);

        // Turn off the switch after execution (momentary switch behavior)
        setTimeout(() => {
          const service = this.sceneServices.get(sceneId);
          if (service) {
            service.updateCharacteristic(
              this.platform.Characteristic.On,
              false
            );
          }
        }, 1000);
      }
    } catch (error) {
      this.platform.log.error(`Error executing scene ${sceneId}: ${error}`);

      // Turn off the switch if there was an error
      const service = this.sceneServices.get(sceneId);
      if (service) {
        service.updateCharacteristic(this.platform.Characteristic.On, false);
      }
    }
  }

  /**
   * Get scene switch state (always returns false for momentary behavior)
   */
  async getSceneSwitch(sceneId: string): Promise<CharacteristicValue> {
    return false; // Momentary switch - always return false
  }

  notifyDeviceUpdater(id: string, data) {
    try {
      if (id == "CloudMessage" || id == "LocalMessage") {
        const liveData = this.getLiveMessageForThisAccessory(data);
        if (liveData === null) {
          return;
        }

        const rootMessage: any =
          liveData && typeof liveData === "object" ? liveData : null;

        this.platform.log.debug(
          `Updating accessory with ${id} data: ` + JSON.stringify(liveData)
        );

        const payload = Array.isArray(liveData)
          ? liveData
          : liveData
            ? [liveData]
            : [];
        if (payload.length > 0) {
          const messages = payload[0];
          if (!messages || typeof messages !== "object") {
            return;
          }
          if (messages.hasOwnProperty("state")) {
            this.services["Fan"].updateCharacteristic(
              this.platform.Characteristic.Active,
              this.isCleaningState(messages.state)
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE
            );
          }

          if (
            messages.hasOwnProperty("battery") ||
            messages.hasOwnProperty("charge_status")
          ) {
            this.updateBatteryCharacteristics(
              messages.battery,
              messages.charge_status,
              messages.state
            );
          }

          if (messages.hasOwnProperty("in_cleaning")) {
            this.services["Fan"].updateCharacteristic(
              this.platform.Characteristic.Active,
              messages.in_cleaning != 0
                ? this.platform.Characteristic.Active.ACTIVE
                : this.platform.Characteristic.Active.INACTIVE
            );
          }
        }

        if (this.hasDp(rootMessage, "121")) {
          this.platform.log.debug(
            `${this.platform.roborockAPI.getVacuumDeviceInfo(this.accessory.context, "name")} state update to: ${this.state_code_to_state(rootMessage.dps["121"])}`
          );

          this.services["Fan"].updateCharacteristic(
            this.platform.Characteristic.Active,
            this.isCleaningState(rootMessage.dps["121"])
              ? this.platform.Characteristic.Active.ACTIVE
              : this.platform.Characteristic.Active.INACTIVE
          );
        }

        if (this.hasDp(rootMessage, "122")) {
          this.platform.log.debug(
            `${this.platform.roborockAPI.getVacuumDeviceInfo(this.accessory.context, "name")} battery update to: ${rootMessage.dps["122"]}`
          );

          this.updateBatteryCharacteristics(
            rootMessage.dps["122"],
            rootMessage.dps["123"],
            rootMessage.dps["121"]
          );
        }
      } else if (id == "HomeData") {
        this.updateDeviceState();
        // Update scene switches when home data changes
        this.updateSceneSwitches();
      }
    } catch (e) {
      this.platform.log.error("Error notifying device updater: " + e);
    }
  }

  /**
   * Whether `msg.dps` is present and carries the given data point key.
   */
  private hasDp(msg: any, key: string): boolean {
    return (
      !!msg?.dps &&
      typeof msg.dps === "object" &&
      Object.prototype.hasOwnProperty.call(msg.dps, key)
    );
  }

  private getLiveMessageForThisAccessory(data: unknown): unknown | null {
    return getLiveMessageForThisAccessory(data, {
      getDuid: () => this.getDuid(),
      getVacuumName: () => this.getVacuumName(),
      shouldAcceptUnscopedLiveMessage: () =>
        this.platform.shouldAcceptUnscopedLiveMessage(),
      logDebug: (message) => this.platform.log.debug(message),
    });
  }

  async setActive(value: CharacteristicValue) {
    try {
      const vacuumName = this.getVacuumName();
      const command =
        value == this.platform.Characteristic.Active.ACTIVE
          ? "start cleaning"
          : "stop cleaning";
      this.platform.log.info(
        `HomeKit fan command received for ${vacuumName}: ${command}.`
      );

      if (value == this.platform.Characteristic.Active.ACTIVE) {
        const startedAt = Date.now();
        await this.platform.roborockAPI.app_start(this.accessory.context, {
          waitForResult: true,
        });
        this.platform.log.info(
          `HomeKit fan start command for ${vacuumName} was acknowledged by Roborock in ${Date.now() - startedAt} ms.`
        );
      } else {
        this.platform.log.info(
          `Stopping ${vacuumName}. Use the Return to Dock switch to dock intentionally.`
        );
        const startedAt = Date.now();
        await this.platform.roborockAPI.app_stop(this.accessory.context, {
          waitForResult: true,
        });
        this.platform.log.info(
          `HomeKit fan stop command for ${vacuumName} was acknowledged by Roborock in ${Date.now() - startedAt} ms.`
        );
      }

      this.services["Fan"].updateCharacteristic(
        this.platform.Characteristic.Active,
        value
      );
    } catch (e) {
      this.platform.log.error("Error setting active: " + e);
    }
  }

  async getActive(): Promise<CharacteristicValue> {
    this.updateDeviceState();
    return this.isCleaning()
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  state_code_to_state(code: number): string {
    return stateCodes[code] || "Unknown";
  }

  isCleaning(): boolean {
    return this.isCleaningState(
      this.platform.roborockAPI.getVacuumDeviceStatus(
        this.accessory.context,
        "state"
      )
    );
  }

  isCleaningState(state: number): boolean {
    return CLEANING_STATES.has(state);
  }

  private updateBatteryCharacteristics(
    batteryValue: unknown,
    chargeStatusValue: unknown,
    stateValue: unknown
  ): void {
    const normalizedBattery = this.getNormalizedBatteryLevel(
      batteryValue,
      chargeStatusValue,
      stateValue
    );

    if (normalizedBattery !== null) {
      this.lastKnownBatteryLevel = normalizedBattery;
      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.BatteryLevel,
        normalizedBattery
      );

      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        normalizedBattery < 20
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
      );
    }

    if (typeof chargeStatusValue === "number") {
      this.services["Battery"].updateCharacteristic(
        this.platform.Characteristic.ChargingState,
        chargeStatusValue != 0
          ? this.platform.Characteristic.ChargingState.CHARGING
          : this.platform.Characteristic.ChargingState.NOT_CHARGING
      );
    }
  }

  private getNormalizedBatteryLevel(
    batteryValue: unknown,
    chargeStatusValue: unknown,
    stateValue: unknown
  ): number | null {
    if (typeof batteryValue !== "number" || Number.isNaN(batteryValue)) {
      return this.lastKnownBatteryLevel;
    }

    if (batteryValue < 0 || batteryValue > 100) {
      return this.lastKnownBatteryLevel;
    }

    const isCharging =
      typeof chargeStatusValue === "number" && chargeStatusValue !== 0;
    const isDockedState = stateValue === 8 || stateValue === 100;

    if (
      batteryValue === 0 &&
      this.lastKnownBatteryLevel !== null &&
      this.lastKnownBatteryLevel > 0 &&
      (isCharging || isDockedState)
    ) {
      this.platform.log.debug(
        `Ignoring transient 0% battery report for ${this.platform.roborockAPI.getVacuumDeviceInfo(this.accessory.context, "name")} while docked/charging; keeping last known value ${this.lastKnownBatteryLevel}%.`
      );
      return this.lastKnownBatteryLevel;
    }

    return batteryValue;
  }
}
