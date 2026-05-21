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

/**
 * Optional Homebridge 2 Matter exposure for Apple Home's native vacuum UI.
 *
 * This intentionally uses runtime `any` access instead of importing Homebridge
 * Matter types so the plugin still compiles and runs on Homebridge 1.x.
 */
export default class RoborockMatterVacuumAccessory {
  private registered: boolean;

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
    if (id === "CloudMessage" || id === "LocalMessage" || id === "HomeData") {
      await this.updateMatterStateFromRoborock();
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
      await this.updateMatterState({
        rvcRunMode: { currentMode: RUN_MODE_CLEANING },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.RUNNING,
        },
      });
      return;
    }

    if (newMode === RUN_MODE_IDLE) {
      this.platform.log.info(
        `Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`
      );
      await this.platform.roborockAPI.app_stop(duid);
      await this.updateMatterState({
        rvcRunMode: { currentMode: RUN_MODE_IDLE },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.STOPPED,
        },
      });
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter run mode '${newMode}' for ${name}.`
    );
  }

  private async changeCleanMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();

    if (newMode === CLEAN_MODE_VACUUM) {
      await this.updateMatterState({
        rvcCleanMode: { currentMode: CLEAN_MODE_VACUUM },
      });
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
    );
  }

  private async pauseCleaning(): Promise<void> {
    this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
    await this.platform.roborockAPI.app_pause(this.getDuid());
    await this.updateMatterState({
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    });
  }

  private async resumeCleaning(): Promise<void> {
    this.platform.log.info(`Resuming ${this.getVacuumName()} from Matter.`);
    await this.platform.roborockAPI.app_start(this.getDuid());
    await this.updateMatterState({
      rvcRunMode: { currentMode: RUN_MODE_CLEANING },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.RUNNING,
      },
    });
  }

  private async returnToDock(): Promise<void> {
    this.platform.log.info(
      `Sending ${this.getVacuumName()} back to dock from Matter.`
    );
    await this.platform.roborockAPI.app_charge(this.getDuid());
    await this.updateMatterState({
      rvcRunMode: { currentMode: RUN_MODE_IDLE },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
      },
    });
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

  private buildClusters(): Record<string, Record<string, unknown>> {
    return {
      rvcRunMode: this.buildRunModeCluster(),
      rvcCleanMode: this.buildCleanModeCluster(),
      rvcOperationalState: this.buildOperationalStateCluster(),
      powerSource: this.buildPowerSourceCluster(),
    };
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
      currentMode: this.isInCleaningRunMode()
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

  private buildPowerSourceCluster(): Record<string, unknown> {
    const battery = this.getNumberStatus("battery");
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

  private getOperationalState(): number {
    const state = this.getNumberStatus("state");
    const chargeStatus = this.getNumberStatus("charge_status");

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

  private isInCleaningRunMode(): boolean {
    switch (this.getOperationalState()) {
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

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
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
