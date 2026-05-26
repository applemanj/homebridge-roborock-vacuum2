import RoborockPlatform from "./platform";

type MatterAccessory = {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision?: string;
  context: Record<string, unknown>;
  clusters?: Record<string, Record<string, unknown>>;
  handlers?: Record<string, Record<string, unknown>>;
  getState?: (cluster: string, attribute: string) => Promise<unknown>;
};

type MatterClusterState = Record<string, Record<string, unknown>>;

type RoborockDevice = {
  duid: string;
  name?: string;
};

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
const CLEAN_MODE_VACUUM = 0;

const RVC_RUN_MODE_TAG_IDLE = 16384;
const RVC_RUN_MODE_TAG_CLEANING = 16385;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;

const RVC_OPERATIONAL_STATE = {
  STOPPED: 0,
  RUNNING: 1,
  PAUSED: 2,
  ERROR: 3,
  SEEKING_CHARGER: 64,
  CHARGING: 65,
  DOCKED: 66,
  EMPTYING_DUST_BIN: 67,
  CLEANING_MOP: 68,
  UPDATING_MAPS: 70,
} as const;

const RVC_OPERATIONAL_STATE_LIST = [
  RVC_OPERATIONAL_STATE.STOPPED,
  RVC_OPERATIONAL_STATE.RUNNING,
  RVC_OPERATIONAL_STATE.PAUSED,
  RVC_OPERATIONAL_STATE.ERROR,
  RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
  RVC_OPERATIONAL_STATE.CHARGING,
  RVC_OPERATIONAL_STATE.DOCKED,
  RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN,
  RVC_OPERATIONAL_STATE.CLEANING_MOP,
  RVC_OPERATIONAL_STATE.UPDATING_MAPS,
] as const;

const RVC_ERROR_STATE = {
  NO_ERROR: 0,
  UNABLE_TO_COMPLETE_OPERATION: 2,
} as const;

const OPTIMISTIC_STATE_TTL_MS = 2 * 60 * 1000;

/**
 * Optional Homebridge 2 Matter exposure for Apple Home's native vacuum UI.
 *
 * This intentionally uses runtime `any` access instead of importing Homebridge
 * Matter types so the plugin still compiles and runs on Homebridge 1.x.
 */
export default class RoborockMatterVacuumAccessory {
  private registered: boolean;
  private optimisticClusters: MatterClusterState | null = null;
  private optimisticExpiresAt = 0;

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: MatterAccessory,
    device: RoborockDevice,
    isRegistered = false
  ) {
    this.registered = isRegistered;
    this.updateMetadata(device);
  }

  markRegistered(): void {
    this.registered = true;
  }

  updateMetadata(device: RoborockDevice): void {
    const duid = device.duid;
    const displayName =
      this.platform.roborockAPI.getVacuumDeviceInfo(duid, "name") ||
      device.name ||
      "Roborock Vacuum";

    this.accessory.displayName = displayName;
    this.accessory.manufacturer = "Roborock";
    this.accessory.model =
      this.platform.roborockAPI.getProductAttribute(duid, "model") ||
      this.platform.roborockAPI.getVacuumDeviceInfo(duid, "model") ||
      "Roborock Vacuum";
    this.accessory.serialNumber =
      this.platform.roborockAPI.getVacuumDeviceInfo(duid, "sn") || duid;
    const firmwareRevision = this.platform.roborockAPI.getVacuumDeviceInfo(
      duid,
      "fv"
    );
    if (firmwareRevision) {
      this.accessory.firmwareRevision = firmwareRevision;
    } else {
      delete this.accessory.firmwareRevision;
    }
    this.accessory.context = { ...(this.accessory.context || {}), duid };
    this.accessory.clusters = this.buildClusters();
    this.accessory.handlers = this.buildHandlers();
    this.accessory.getState = async (cluster, attribute) => {
      const clusterState = this.buildClusters()[cluster];
      return clusterState ? clusterState[attribute] : undefined;
    };
  }

  async notifyDeviceUpdater(id: string, data: unknown): Promise<void> {
    if (id === "HomeData") {
      await this.updateMatterStateFromRoborock();
      return;
    }

    if (id === "CloudMessage" || id === "LocalMessage") {
      await this.updateMatterStateFromMessage(data);
    }
  }

  async updateMatterStateFromRoborock(): Promise<void> {
    if (!this.registered) {
      return;
    }

    const matter = this.platform.getMatterApi();
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return;
    }

    const clusters = this.buildClusters();
    await Promise.all(
      Object.entries(clusters).map(([cluster, attributes]) =>
        matter.updateAccessoryState(this.accessory.UUID, cluster, attributes)
      )
    );
  }

  private buildHandlers(): Record<string, Record<string, unknown>> {
    return {
      rvcRunMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeRunMode(request?.newMode);
        },
      },
      rvcCleanMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeCleanMode(request?.newMode);
        },
      },
      rvcOperationalState: {
        pause: async () => {
          await this.pauseCleaning();
        },
        resume: async () => {
          await this.resumeCleaning();
        },
        goHome: async () => {
          await this.returnToDock();
        },
      },
    };
  }

  private async changeRunMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();
    const duid = this.getDuid();

    if (newMode === RUN_MODE_CLEANING) {
      this.platform.log.info(`Starting ${name} from Matter.`);
      await this.platform.roborockAPI.app_start(duid);
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_CLEANING },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.RUNNING,
        },
      };
      this.setOptimisticState(state);
      await this.updateMatterState(state);
      return;
    }

    if (newMode === RUN_MODE_IDLE) {
      this.platform.log.info(
        `Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`
      );
      await this.platform.roborockAPI.app_stop(duid);
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_IDLE },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.STOPPED,
        },
      };
      this.setOptimisticState(state);
      await this.updateMatterState(state);
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter run mode '${newMode}' for ${name}.`
    );
  }

  private async changeCleanMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();

    if (newMode === CLEAN_MODE_VACUUM) {
      const state = {
        rvcCleanMode: { currentMode: CLEAN_MODE_VACUUM },
      };
      this.setOptimisticState(state);
      await this.updateMatterState(state);
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
    );
  }

  private async pauseCleaning(): Promise<void> {
    this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
    await this.platform.roborockAPI.app_pause(this.getDuid());
    const state = {
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    };
    this.setOptimisticState(state);
    await this.updateMatterState(state);
  }

  private async resumeCleaning(): Promise<void> {
    this.platform.log.info(`Resuming ${this.getVacuumName()} from Matter.`);
    await this.platform.roborockAPI.app_start(this.getDuid());
    const state = {
      rvcRunMode: { currentMode: RUN_MODE_CLEANING },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.RUNNING,
      },
    };
    this.setOptimisticState(state);
    await this.updateMatterState(state);
  }

  private async returnToDock(): Promise<void> {
    this.platform.log.info(
      `Sending ${this.getVacuumName()} back to dock from Matter.`
    );
    await this.platform.roborockAPI.app_charge(this.getDuid());
    const state = {
      rvcRunMode: { currentMode: RUN_MODE_IDLE },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
      },
    };
    this.setOptimisticState(state);
    await this.updateMatterState(state);
  }

  private async updateMatterState(
    partialClusters: Record<string, Record<string, unknown>>
  ): Promise<void> {
    if (!this.registered) {
      return;
    }

    const matter = this.platform.getMatterApi();
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return;
    }

    await Promise.all(
      Object.entries(partialClusters).map(([cluster, attributes]) =>
        matter.updateAccessoryState(this.accessory.UUID, cluster, attributes)
      )
    );
  }

  private async updateMatterStateFromMessage(data: unknown): Promise<void> {
    if (!this.registered) {
      return;
    }

    const status = this.extractStatusUpdate(data);
    if (!status) {
      return;
    }

    const state = this.getNumberFromValue(status.state);
    const chargeStatus = this.getNumberFromValue(status.charge_status);
    const battery = this.getNumberFromValue(status.battery);
    const clusters: MatterClusterState = {};

    if (state !== null || chargeStatus !== null) {
      const operationalState = this.getOperationalState(state, chargeStatus);
      const suppressState = this.shouldSuppressLiveState(operationalState);

      if (!suppressState) {
        clusters.rvcRunMode = {
          currentMode: this.isInCleaningRunMode(operationalState)
            ? RUN_MODE_CLEANING
            : RUN_MODE_IDLE,
        };
        clusters.rvcOperationalState = { operationalState };
      }
    }

    if (battery !== null) {
      clusters.powerSource = this.buildPowerSourceCluster(battery);
    }

    if (Object.keys(clusters).length > 0) {
      await this.updateMatterState(clusters);
    }
  }

  private buildClusters(): MatterClusterState {
    return this.applyOptimisticState({
      rvcRunMode: this.buildRunModeCluster(),
      rvcCleanMode: this.buildCleanModeCluster(),
      rvcOperationalState: this.buildOperationalStateCluster(),
      powerSource: this.buildPowerSourceCluster(),
    });
  }

  private buildRunModeCluster(): Record<string, unknown> {
    return {
      supportedModes: [
        {
          label: "Idle",
          mode: RUN_MODE_IDLE,
          modeTags: [{ value: RVC_RUN_MODE_TAG_IDLE }],
        },
        {
          label: "Cleaning",
          mode: RUN_MODE_CLEANING,
          modeTags: [{ value: RVC_RUN_MODE_TAG_CLEANING }],
        },
      ],
      currentMode: this.isInCleaningRunMode(this.getOperationalState())
        ? RUN_MODE_CLEANING
        : RUN_MODE_IDLE,
    };
  }

  private buildCleanModeCluster(): Record<string, unknown> {
    return {
      supportedModes: [
        {
          label: "Vacuum",
          mode: CLEAN_MODE_VACUUM,
          modeTags: [{ value: RVC_CLEAN_MODE_TAG_VACUUM }],
        },
      ],
      currentMode: CLEAN_MODE_VACUUM,
    };
  }

  private buildOperationalStateCluster(): Record<string, unknown> {
    const operationalState = this.getOperationalState();
    const operationalError: Record<string, unknown> = {
      errorStateId:
        operationalState === RVC_OPERATIONAL_STATE.ERROR
          ? RVC_ERROR_STATE.UNABLE_TO_COMPLETE_OPERATION
          : RVC_ERROR_STATE.NO_ERROR,
    };

    return {
      phaseList: null,
      currentPhase: null,
      countdownTime: null,
      // Matter only allows labels for manufacturer-specific operational states.
      operationalStateList: RVC_OPERATIONAL_STATE_LIST.map(
        (operationalStateId) => ({ operationalStateId })
      ),
      operationalState,
      operationalError,
    };
  }

  private buildPowerSourceCluster(
    batteryValue?: number
  ): Record<string, unknown> {
    const battery =
      batteryValue === undefined
        ? this.getNumberStatus("battery")
        : batteryValue;
    const normalizedBattery =
      battery === null ? null : Math.max(0, Math.min(100, battery));

    return {
      description: "Roborock vacuum battery",
      batPresent: normalizedBattery !== null,
      batPercentRemaining:
        normalizedBattery === null ? null : normalizedBattery * 2,
      batChargeLevel:
        normalizedBattery !== null && normalizedBattery <= 10
          ? 2
          : normalizedBattery !== null && normalizedBattery < 20
            ? 1
            : 0,
      batReplacementNeeded: false,
    };
  }

  private getOperationalState(
    state = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): number {
    switch (state) {
      case 5: // Cleaning
      case 11: // Spot Cleaning
      case 16: // Go To
      case 17: // Zone Clean
      case 18: // Room Clean
      case 4: // Remote Control
      case 7: // Manual Mode
        return RVC_OPERATIONAL_STATE.RUNNING;
      case 10: // Paused
        return RVC_OPERATIONAL_STATE.PAUSED;
      case 6: // Returning Dock
      case 15: // Docking
      case 26: // Going to wash the mop
        return RVC_OPERATIONAL_STATE.SEEKING_CHARGER;
      case 8: // Charging
        return RVC_OPERATIONAL_STATE.CHARGING;
      case 9: // Charging Error
      case 12: // In Error
        return RVC_OPERATIONAL_STATE.ERROR;
      case 22: // Emptying dust container
        return RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN;
      case 23: // Washing the mop
        return RVC_OPERATIONAL_STATE.CLEANING_MOP;
      case 29: // Mapping
        return RVC_OPERATIONAL_STATE.UPDATING_MAPS;
      case 100: // Fully Charged
        return RVC_OPERATIONAL_STATE.DOCKED;
      default:
        if (chargeStatus !== null && chargeStatus !== 0) {
          return RVC_OPERATIONAL_STATE.CHARGING;
        }

        return RVC_OPERATIONAL_STATE.STOPPED;
    }
  }

  private isInCleaningRunMode(operationalState: number): boolean {
    switch (operationalState) {
      case RVC_OPERATIONAL_STATE.RUNNING:
      case RVC_OPERATIONAL_STATE.PAUSED:
      case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
      case RVC_OPERATIONAL_STATE.CLEANING_MOP:
      case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
        return true;
      default:
        return false;
    }
  }

  private getNumberStatus(property: string): number | null {
    const value = this.platform.roborockAPI.getVacuumDeviceStatus(
      this.getDuid(),
      property
    );

    return this.getNumberFromValue(value);
  }

  private getNumberFromValue(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private extractStatusUpdate(data: unknown): Record<string, unknown> | null {
    const rootMessage = this.asRecord(data);
    const dps = this.asRecord(rootMessage?.dps);

    if (dps) {
      const status: Record<string, unknown> = {};

      if (Object.prototype.hasOwnProperty.call(dps, "121")) {
        status.state = dps["121"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "122")) {
        status.battery = dps["122"];
      }
      if (Object.prototype.hasOwnProperty.call(dps, "123")) {
        status.charge_status = dps["123"];
      }

      return Object.keys(status).length > 0 ? status : null;
    }

    const payload = Array.isArray(data) ? data : data ? [data] : [];
    const message = this.asRecord(payload[0]);
    if (!message) {
      return null;
    }

    const hasStatus =
      Object.prototype.hasOwnProperty.call(message, "state") ||
      Object.prototype.hasOwnProperty.call(message, "battery") ||
      Object.prototype.hasOwnProperty.call(message, "charge_status");

    return hasStatus ? message : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  }

  private setOptimisticState(partialClusters: MatterClusterState): void {
    this.optimisticClusters = this.mergeClusterState(
      this.getActiveOptimisticState() || {},
      partialClusters
    );
    this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_TTL_MS;
  }

  private shouldSuppressLiveState(operationalState: number): boolean {
    const optimistic = this.getActiveOptimisticState();
    const expected = optimistic?.rvcOperationalState?.operationalState;

    if (typeof expected !== "number") {
      return false;
    }

    if (this.doesLiveStateConfirmOptimisticState(expected, operationalState)) {
      this.clearOptimisticState();
      return false;
    }

    return true;
  }

  private doesLiveStateConfirmOptimisticState(
    expected: number,
    actual: number
  ): boolean {
    if (expected === actual) {
      return true;
    }

    if (
      expected === RVC_OPERATIONAL_STATE.RUNNING &&
      this.isInCleaningRunMode(actual)
    ) {
      return true;
    }

    if (
      expected === RVC_OPERATIONAL_STATE.STOPPED &&
      !this.isInCleaningRunMode(actual)
    ) {
      return true;
    }

    return (
      expected === RVC_OPERATIONAL_STATE.SEEKING_CHARGER &&
      (actual === RVC_OPERATIONAL_STATE.CHARGING ||
        actual === RVC_OPERATIONAL_STATE.DOCKED)
    );
  }

  private applyOptimisticState(
    clusters: MatterClusterState
  ): MatterClusterState {
    const optimistic = this.getActiveOptimisticState();
    return optimistic ? this.mergeClusterState(clusters, optimistic) : clusters;
  }

  private getActiveOptimisticState(): MatterClusterState | null {
    if (!this.optimisticClusters) {
      return null;
    }

    if (Date.now() > this.optimisticExpiresAt) {
      this.clearOptimisticState();
      return null;
    }

    return this.optimisticClusters;
  }

  private clearOptimisticState(): void {
    this.optimisticClusters = null;
    this.optimisticExpiresAt = 0;
  }

  private mergeClusterState(
    base: MatterClusterState,
    override: MatterClusterState
  ): MatterClusterState {
    const merged: MatterClusterState = { ...base };

    for (const [cluster, attributes] of Object.entries(override)) {
      merged[cluster] = {
        ...(merged[cluster] || {}),
        ...attributes,
      };
    }

    return merged;
  }

  private getVacuumName(): string {
    return (
      this.platform.roborockAPI.getVacuumDeviceInfo(this.getDuid(), "name") ||
      this.accessory.displayName ||
      "Roborock vacuum"
    );
  }

  private getDuid(): string {
    return String(this.accessory.context.duid);
  }
}
