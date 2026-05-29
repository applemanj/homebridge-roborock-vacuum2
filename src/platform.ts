import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import RoborockVacuumAccessory from "./vacuum_accessory";
import RoborockMatterVacuumAccessory from "./matter_vacuum_accessory";

import RoborockPlatformLogger from "./logger";
import { RoborockPlatformConfig } from "./types";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { forEach } from "jszip";
import { decryptSession } from "./crypto";

const DEP0040_CODE = "DEP0040";
let dep0040FilterInstalled = false;
const DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS = 6;

function installDeprecationWarningFilter(): void {
  if (dep0040FilterInstalled) {
    return;
  }

  dep0040FilterInstalled = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  let dep0040Logged = false;

  process.emitWarning = ((
    warning: string | Error,
    type?: string,
    code?: string,
    ctor?: Function
  ): void => {
    const warningCode =
      typeof warning === "object" && warning !== null && "code" in warning
        ? String((warning as { code?: string }).code)
        : code;

    if (warningCode === DEP0040_CODE) {
      if (!dep0040Logged) {
        dep0040Logged = true;
        process.stderr.write(
          "[Roborock Vacuum] Suppressed Node.js DEP0040 warning from upstream dependency.\n"
        );
      }
      return;
    }

    (originalEmitWarning as (...args: unknown[]) => void)(
      warning,
      type,
      code,
      ctor
    );
  }) as typeof process.emitWarning;
}

installDeprecationWarningFilter();

const Roborock = require("../roborockLib/roborockAPI").Roborock;

/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
export default class RoborockPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // Used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  private readonly vacuums: RoborockVacuumAccessory[] = [];
  private readonly matterAccessories: any[] = [];
  private readonly matterVacuums: Map<string, RoborockMatterVacuumAccessory> =
    new Map();
  private matterUnavailableLogged = false;

  public readonly roborockAPI: any;
  public readonly log: RoborockPlatformLogger;

  public platformConfig: RoborockPlatformConfig;

  /**
   * This constructor is where you should parse the user config
   * and discover/register accessories with Homebridge.
   *
   * @param logger Homebridge logger
   * @param config Homebridge platform config
   * @param api Homebridge API
   */
  constructor(
    homebridgeLogger: Logger,
    config: PlatformConfig,
    private readonly api: API
  ) {
    this.platformConfig = config as RoborockPlatformConfig;

    // Initialise logging utility
    this.log = new RoborockPlatformLogger(
      homebridgeLogger,
      this.platformConfig.debugMode
    );
    // Create Roborock App communication module

    const username = this.platformConfig.email;
    const password = this.platformConfig.password;
    const baseURL = this.platformConfig.baseURL;
    const debugMode = this.platformConfig.debugMode;
    const transientWarningThrottleHours =
      this.normalizeTransientWarningThrottleHours(
        this.platformConfig.transientWarningThrottleHours
      );

    const storagePath = this.api.user.storagePath();
    const decryptedSession = this.platformConfig.encryptedToken
      ? decryptSession(this.platformConfig.encryptedToken, storagePath)
      : null;

    this.roborockAPI = new Roborock({
      username: username,
      password: password,
      debug: debugMode,
      baseURL: baseURL,
      skipDevices: this.platformConfig.skipDevices,
      enableMatterServiceAreaBeta:
        this.platformConfig.enableMatterServiceAreaBeta,
      log: this.log,
      userData: decryptedSession,
      storagePath: storagePath,
      errorLogThrottleMs: transientWarningThrottleHours * 60 * 60 * 1000,
    });

    /**
     * When this event is fired it means Homebridge has restored all cached accessories from disk.
     * Dynamic Platform plugins should only register new accessories after this event was fired,
     * in order to ensure they weren't added to homebridge already. This event can also be used
     * to start discovery of new accessories.
     */
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug("Finished launching and restored cached accessories.");
      this.configurePlugin();
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.debug("Shutting down...");

      if (this.roborockAPI) {
        this.roborockAPI.stopService();
      }
    });
  }

  async configurePlugin() {
    await this.loginAndDiscoverDevices();
  }

  private normalizeTransientWarningThrottleHours(value: unknown): number {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;

    if (!Number.isFinite(parsed) || parsed < 0) {
      return DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;
    }

    return parsed;
  }

  async loginAndDiscoverDevices() {
    if (!this.platformConfig.email) {
      this.log.error(
        "Email is not configured - aborting plugin start. " +
          "Please set the field `email` in your config and restart Homebridge."
      );
      return;
    }

    if (!this.platformConfig.password && !this.platformConfig.encryptedToken) {
      this.log.error(
        "Password is not configured - aborting plugin start. " +
          "Please set `password` or complete login in the Config UI."
      );
      return;
    }

    const self = this;

    self.roborockAPI.setDeviceNotify(function (id, homeData) {
      self.log.debug(`${id} notifyDeviceUpdater:${JSON.stringify(homeData)}`);

      for (const vacuum of self.vacuums) {
        vacuum.notifyDeviceUpdater(id, homeData);
      }

      for (const vacuum of self.matterVacuums.values()) {
        vacuum.notifyDeviceUpdater(id, homeData).catch((error) => {
          self.log.debug("Error updating Matter vacuum state: " + error);
        });
      }
    });

    self.roborockAPI.startService(function () {
      self.log.info("Service started");
      //call the discoverDevices function
      self.discoverDevices();
    });
  }

  /**
   * This function is invoked when Homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory '${accessory.displayName}' from cache.`);

    // Store restored accessory in the cached accessories list
    // remove duplicates accessories

    try {
      const existingAccessory = this.accessories.find(
        (a) => a.UUID === accessory.UUID
      );
      if (existingAccessory) {
        this.log.info(
          `Removing duplicate accessory '${existingAccessory.displayName}' from cache.`
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          existingAccessory,
        ]);
      }
    } catch (e) {
      this.log.error("Error loading accessory from cache: " + e);
    }

    this.accessories.push(accessory);
  }

  /**
   * Homebridge 2 calls this for cached Matter accessories. Keep this optional
   * and runtime-typed so Homebridge 1.x users remain fully supported.
   */
  configureMatterAccessory(accessory: any) {
    this.log.info(
      `Loading Matter accessory '${accessory.displayName}' from cache.`
    );
    this.matterAccessories.push(accessory);

    if (!this.platformConfig.enableMatter) {
      return;
    }

    const duid = this.getMatterAccessoryDuid(accessory);
    if (!duid) {
      return;
    }

    const matter = this.getMatterApi();
    if (!matter?.deviceTypes?.RoboticVacuumCleaner) {
      return;
    }

    accessory.deviceType = matter.deviceTypes.RoboticVacuumCleaner;
    this.applyMatterAccessoryIdentity(accessory, {
      duid,
      name: accessory.displayName,
    });
    this.createOrUpdateMatterVacuum(
      { duid, name: accessory.displayName },
      accessory,
      true
    );
  }

  isSupportedDevice(model: string): boolean {
    return typeof model === "string" && model.startsWith("roborock.vacuum.");
  }

  /**
   * Fetches all of the user's devices from Roborock App and sets up handlers.
   *
   * Accessories must only be registered once. Previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    this.log.info("Discovering vacuum devices...");

    try {
      const self = this;

      if (self.roborockAPI.isInited()) {
        const devices = self.roborockAPI.getVacuumList();

        for (const device of devices) {
          const duid = device.duid;
          const name = device.name;
          const model = self.roborockAPI.getProductAttribute(duid, "model");

          if (!self.isSupportedDevice(model)) {
            self.log.info(
              `Device '${name}' (${duid}) is not supported (model '${model || "unknown"}').`
            );

            continue;
          }

          const uuid = self.api.hap.uuid.generate(device.duid);

          const existingAccessory = self.accessories.find(
            (accessory) => accessory.UUID === uuid
          );

          if (existingAccessory !== undefined) {
            self.log.info(
              `Restoring accessory '${existingAccessory.displayName}' ` +
                `(${uuid}) from cache.`
            );

            // If you need to update the accessory.context then you should run
            // `api.updatePlatformAccessories`. eg.:
            existingAccessory.context = duid;
            self.api.updatePlatformAccessories([existingAccessory]);

            // Create the accessory handler for the restored accessory

            self.createRoborockAccessory(existingAccessory);
          } else {
            // The accessory already exists, so we need to create it

            self.log.info(`Adding accessory '${name}' (${uuid}).`);
            // The accessory does not yet exist, so we need to create it
            const accessory = new self.api.platformAccessory<String>(
              name,
              uuid
            );

            // Store a copy of the device object in the `accessory.context` property,
            // which can be used to store any data about the accessory you may need.
            accessory.context = duid;

            // Create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            self.createRoborockAccessory(accessory);

            // Link the accessory to your platform
            self.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
              accessory,
            ]);
          }

          await self.discoverMatterVacuum(device);
        }
      }

      // At this point, we set up all devices from Roborock App, but we did not unregister
      // cached devices that do not exist on the Roborock App account anymore.
      for (const cachedAccessory of this.accessories) {
        if (cachedAccessory.context) {
          const vacuum = self.roborockAPI.getVacuumDeviceData(
            cachedAccessory.context
          );

          if (vacuum === undefined) {
            // This cached devices does not exist on the Roborock App account (anymore).
            this.log.info(
              `Removing accessory '${cachedAccessory.displayName}' (${cachedAccessory.context}) ` +
                "because it does not exist on the Roborock account anymore."
            );

            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
              cachedAccessory,
            ]);
          }
        }
      }

      await this.unregisterStaleMatterAccessories();
    } catch (error) {
      this.log.error(
        "An error occurred during device discovery. " +
          "Turn on debug mode for more information."
      );
      this.log.debug(error);
    }
  }

  createRoborockAccessory(accessory: PlatformAccessory) {
    this.vacuums.push(new RoborockVacuumAccessory(this, accessory));
  }

  getMatterApi(): any | null {
    if (!this.platformConfig.enableMatter) {
      return null;
    }

    const api = this.api as any;
    const matterEnabled =
      typeof api.isMatterEnabled === "function"
        ? api.isMatterEnabled()
        : Boolean(api.matter);

    if (!matterEnabled || !api.matter) {
      if (!this.matterUnavailableLogged) {
        this.matterUnavailableLogged = true;
        this.log.info(
          "Matter vacuum exposure is enabled in plugin settings, but Matter is not enabled for this Homebridge bridge. The existing HomeKit accessory will continue to work."
        );
      }

      return null;
    }

    return api.matter;
  }

  private async discoverMatterVacuum(device: any): Promise<void> {
    const matter = this.getMatterApi();
    if (!matter) {
      return;
    }

    if (!matter.deviceTypes?.RoboticVacuumCleaner) {
      this.log.warn(
        "Matter is enabled, but this Homebridge version does not expose the robotic vacuum device type yet."
      );
      return;
    }

    const uuid = this.generateMatterUuid(device.duid);
    const existingAccessory = this.matterAccessories.find(
      (accessory) => accessory.UUID === uuid
    );
    const accessory =
      existingAccessory ||
      this.createMatterAccessory(
        device,
        matter.deviceTypes.RoboticVacuumCleaner
      );
    const vacuum = this.createOrUpdateMatterVacuum(
      device,
      accessory,
      Boolean(existingAccessory)
    );

    if (existingAccessory) {
      await matter.updatePlatformAccessories([accessory]);
      await vacuum.updateMatterStateFromRoborock();
      return;
    }

    this.log.info(
      `Adding Matter vacuum accessory '${accessory.displayName}' (${uuid}).`
    );
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    this.matterAccessories.push(accessory);
    vacuum.markRegistered();
    await vacuum.updateMatterStateFromRoborock();
  }

  private createMatterAccessory(device: any, deviceType: unknown): any {
    const duid = String(device.duid);
    const accessory = {
      UUID: this.generateMatterUuid(duid),
      deviceType,
      context: { duid },
    };

    this.applyMatterAccessoryIdentity(accessory, device);
    return accessory;
  }

  private applyMatterAccessoryIdentity(accessory: any, device: any): void {
    const duid = String(device.duid);
    const displayName =
      this.roborockAPI.getVacuumDeviceInfo(duid, "name") ||
      device.name ||
      "Roborock Vacuum";
    const firmwareRevision = this.roborockAPI.getVacuumDeviceInfo(duid, "fv");

    accessory.displayName = displayName;
    accessory.serialNumber =
      this.roborockAPI.getVacuumDeviceInfo(duid, "sn") || duid;
    accessory.manufacturer = "Roborock";
    accessory.model =
      this.roborockAPI.getProductAttribute(duid, "model") || "Roborock Vacuum";
    accessory.context = { ...(accessory.context || {}), duid };

    if (firmwareRevision) {
      accessory.firmwareRevision = firmwareRevision;
    } else {
      delete accessory.firmwareRevision;
    }
  }

  private createOrUpdateMatterVacuum(
    device: any,
    accessory: any,
    isRegistered: boolean
  ): RoborockMatterVacuumAccessory {
    const duid = String(device.duid);
    const existing = this.matterVacuums.get(duid);

    if (existing) {
      existing.updateMetadata(device);
      return existing;
    }

    const vacuum = new RoborockMatterVacuumAccessory(
      this,
      accessory,
      device,
      isRegistered
    );
    this.matterVacuums.set(duid, vacuum);
    return vacuum;
  }

  private async unregisterStaleMatterAccessories(): Promise<void> {
    const api = this.api as any;
    const matter = api.matter;
    if (!matter || typeof matter.unregisterPlatformAccessories !== "function") {
      return;
    }

    const currentMatterUuids = new Set(
      this.roborockAPI
        .getVacuumList()
        .filter((device) =>
          this.isSupportedDevice(
            this.roborockAPI.getProductAttribute(device.duid, "model")
          )
        )
        .map((device) => this.generateMatterUuid(device.duid))
    );

    const staleAccessories = this.matterAccessories.filter(
      (accessory) =>
        !this.platformConfig.enableMatter ||
        !currentMatterUuids.has(accessory.UUID)
    );

    if (staleAccessories.length === 0) {
      return;
    }

    await matter.unregisterPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      staleAccessories
    );

    for (const accessory of staleAccessories) {
      const duid = this.getMatterAccessoryDuid(accessory);
      if (duid) {
        this.matterVacuums.delete(duid);
      }

      const index = this.matterAccessories.findIndex(
        (cachedAccessory) => cachedAccessory.UUID === accessory.UUID
      );
      if (index >= 0) {
        this.matterAccessories.splice(index, 1);
      }
    }
  }

  private generateMatterUuid(duid: string): string {
    const api = this.api as any;
    const uuidGenerator = api.matter?.uuid || this.api.hap.uuid;
    return uuidGenerator.generate(`matter:roborock:${duid}`);
  }

  private getMatterAccessoryDuid(accessory: any): string | null {
    if (!accessory?.context) {
      return null;
    }

    if (typeof accessory.context === "string") {
      return accessory.context;
    }

    if (typeof accessory.context.duid === "string") {
      return accessory.context.duid;
    }

    return null;
  }
}
