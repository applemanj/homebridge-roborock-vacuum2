import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";

import RoborockPlatform from "./platform";

const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = 2500;

type MatterAccessory = {
  UUID: string;
  displayName: string;
  name?: string;
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

type MatterServiceArea = {
  areaId: number;
  segmentId: number;
  mapId: number | null;
  mapName: string | null;
  name: string;
};

type MatterServiceAreaMap = {
  mapId: number;
  name: string;
};

type MatterCleanModeCapabilities = {
  canVacuum?: boolean;
  canMop?: boolean;
  canControlFanPower?: boolean;
  canControlWater?: boolean;
};

type RoborockCleanModeSettings = {
  fanPower?: number;
  waterBoxMode?: number | null;
};

type RoborockCommandOptions = {
  waitForResult?: boolean;
  throwOnError?: boolean;
  preferCloud?: boolean;
  preferLocal?: boolean;
  allowOfflineCloudSend?: boolean;
  requestTimeoutMs?: number;
};

type RoborockStatusRefreshOptions = {
  force?: boolean;
  preferCloud?: boolean;
};

function scheduleTimer(
  callback: () => void,
  delayMs: number
): ReturnType<typeof nodeSetTimeout> {
  const setTimer =
    typeof globalThis.setTimeout === "function"
      ? globalThis.setTimeout
      : nodeSetTimeout;

  return setTimer(callback, delayMs);
}

function unrefTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

function clearTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  const clear =
    typeof globalThis.clearTimeout === "function"
      ? globalThis.clearTimeout
      : nodeClearTimeout;

  clear(timer);
}

/**
 * The subset of the runtime Roborock API the Matter accessory depends on.
 * Methods that may be absent on older API builds are optional and guarded with
 * a `typeof === "function"` check before use.
 */
interface RoborockApi {
  getVacuumDeviceInfo(duid: string, property: string): string | undefined;
  getProductAttribute(
    duid: string,
    property: string
  ): string | null | undefined;
  getVacuumDeviceStatus(duid: string, property: string): unknown;
  app_start(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_stop(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_pause(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_charge(duid: string, options?: RoborockCommandOptions): Promise<void>;
  find_me?(duid: string, options?: RoborockCommandOptions): Promise<void>;
  app_segment_clean_by_ids(
    duid: string,
    segments: number[],
    options?: RoborockCommandOptions
  ): Promise<void>;
  getRoomMappingsForDevice?(duid: string): unknown;
  getMapListForDevice?(duid: string): unknown;
  getCurrentMapIdForDevice?(duid: string): unknown;
  getMatterCleanModeCapabilities?(duid: string): MatterCleanModeCapabilities;
  applyMatterCleanModeSettings?(
    duid: string,
    settings: RoborockCleanModeSettings,
    options?: RoborockCommandOptions
  ): Promise<void>;
  load_multi_map?(
    duid: string,
    mapId: number,
    options?: RoborockCommandOptions
  ): Promise<void>;
  getStatus?(
    duid: string,
    options?: RoborockStatusRefreshOptions
  ): Promise<void>;
  getTransportDiagnostics?(): Record<string, unknown> | null | undefined;
}

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;

const RVC_RUN_MODE_TAG_IDLE = 16384;
const RVC_RUN_MODE_TAG_CLEANING = 16385;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;
const RVC_CLEAN_MODE_TAG_MOP = 16386;

const ROBOROCK_FAN_POWER_OFF = 105;
const ROBOROCK_FAN_POWER_BALANCED = 102;
const ROBOROCK_WATER_BOX_OFF = 200;
const ROBOROCK_WATER_BOX_MILD = 201;

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
] as const;

const RVC_BASIC_OPERATIONAL_STATE_LIST = [
  RVC_OPERATIONAL_STATE.STOPPED,
  RVC_OPERATIONAL_STATE.RUNNING,
  RVC_OPERATIONAL_STATE.PAUSED,
  RVC_OPERATIONAL_STATE.ERROR,
] as const;
const RVC_OPERATIONAL_PHASE_LIST = ["State", "State"] as const;
const RVC_OPERATIONAL_PHASE_PRIMARY = 0;
const RVC_OPERATIONAL_PHASE_REFRESH = 1;

const RVC_ERROR_STATE = {
  NO_ERROR: 0,
  UNABLE_TO_COMPLETE_OPERATION: 2,
} as const;

const POWER_SOURCE_STATUS = {
  ACTIVE: 1,
  UNAVAILABLE: 3,
} as const;

const BATTERY_CHARGE_LEVEL = {
  OK: 0,
  WARNING: 1,
  CRITICAL: 2,
} as const;

const BATTERY_CHARGE_STATE = {
  UNKNOWN: 0,
  IS_CHARGING: 1,
  IS_AT_FULL_CHARGE: 2,
  IS_NOT_CHARGING: 3,
} as const;

const SERVICE_AREA_SELECT_STATUS = {
  SUCCESS: 0,
  UNSUPPORTED_AREA: 1,
  INVALID_IN_MODE: 2,
  INVALID_SET: 3,
} as const;

const MATTER_LOCATION_NAME_MAX_LENGTH = 64;
const MATTER_MAP_NAME_MAX_LENGTH = 64;
const MATTER_AREA_ID_MAP_MULTIPLIER = 1_000_000;
const MATTER_AREA_ID_MAX = 0xffffffff;
const OPTIMISTIC_STATE_TTL_MS = 2 * 60 * 1000;
// Number of consecutive contradicting live Roborock states to tolerate before
// abandoning an optimistic state, so a command the robot acknowledged but did
// not act on cannot keep Apple Home on a wrong state until the TTL expires.
const OPTIMISTIC_CONTRADICTION_LIMIT = 2;
const SLOW_MATTER_COMMAND_MS = 3000;
const MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS = [2000, 15000] as const;
const MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS = [
  0, 2000, 5000, 10000, 20000, 30000,
] as const;
const MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS = [
  2000, 15000, 30000, 60000, 90000, 120000, 150000, 180000,
] as const;
const MATTER_INITIALIZATION_RETRY_DELAYS_MS = [1000, 3000, 10000] as const;
const MATTER_STATE_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MATTER_READY_FORCE_REFRESH_INTERVAL_MS = 30 * 1000;
const MATTER_READY_READ_REFRESH_INTERVAL_MS = 10 * 1000;
const MATTER_READY_IDENTIFY_REFRESH_INTERVAL_MS = 10 * 1000;
const MATTER_ACTIVE_IDENTIFY_REFRESH_INTERVAL_MS = 10 * 1000;
const MATTER_READY_IDENTIFY_REFRESH_SECONDS = 1;
const MATTER_READY_IDENTIFY_REFRESH_CLEAR_MS = 1200;
const MATTER_STATE_HEARTBEAT_ENABLED = true;
const MATTER_READY_FORCE_REFRESH_ENABLED = false;

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
  private optimisticGeneration = 0;
  private optimisticAction: string | null = null;
  private contradictingLiveStateCount = 0;
  private selectedServiceAreaIds: number[] = [];
  private lastServiceAreaSummary = "";
  private selectedCleanMode = CLEAN_MODE_VACUUM;
  private selectedCleanModeNeedsApply = false;
  private currentMatterRefreshPhase = RVC_OPERATIONAL_PHASE_PRIMARY;
  private lastVacuumFanPower: number | null = null;
  private lastWaterBoxMode: number | null = null;
  private matterInitializationRetryAttempt = 0;
  private matterInitializationRetryPending = false;
  private lastMatterReadyForceRefreshAt = 0;
  private lastMatterReadRefreshAt = 0;
  private lastMatterReadyIdentifyRefreshAt =
    -MATTER_READY_IDENTIFY_REFRESH_INTERVAL_MS;
  private lastMatterActiveIdentifyRefreshAt =
    -MATTER_ACTIVE_IDENTIFY_REFRESH_INTERVAL_MS;
  private matterStateHeartbeatTimer: ReturnType<typeof nodeSetTimeout> | null =
    null;
  private matterActiveIdentifyRefreshTimer: ReturnType<
    typeof nodeSetTimeout
  > | null = null;
  private readonly lastPublishedMatterAttributes: Map<
    string,
    Map<string, string>
  > = new Map();
  // Freshest status values seen from live Roborock messages. Preferred over the
  // slower HomeData snapshot when rebuilding clusters so registration snapshots
  // and attribute reads do not lag behind the latest push.
  private liveStatus: Map<string, number> = new Map();

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: MatterAccessory,
    device: RoborockDevice,
    isRegistered = false
  ) {
    this.registered = isRegistered;
    this.updateMetadata(device);
  }

  private get api(): RoborockApi {
    return this.platform.roborockAPI as RoborockApi;
  }

  private getMatterCommandOptions(): RoborockCommandOptions {
    const options: RoborockCommandOptions = {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    };
    if (this.platform.platformConfig.preferCloudForMatterCommands) {
      options.preferCloud = true;
      delete options.preferLocal;
    }

    return options;
  }

  private getMatterMapLoadCommandOptions(): RoborockCommandOptions {
    const options: RoborockCommandOptions = {
      ...this.getMatterCommandOptions(),
      // Some older Roborock models apply load_multi_map but never complete the
      // local pending request. The cloud path gives Matter room cleaning a
      // reliable acknowledgement without forcing all Matter commands to cloud.
      preferCloud: true,
    };
    delete options.preferLocal;
    return options;
  }

  private getMatterCleanModePrepCommandOptions(): RoborockCommandOptions {
    return {
      ...this.getMatterCommandOptions(),
      requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
    };
  }

  markRegistered(): void {
    this.registered = true;
  }

  scheduleMatterStateRefresh(reason: string, delayMs = 0): void {
    if (!this.registered) {
      return;
    }

    scheduleTimer(() => {
      void this.updateMatterStateFromRoborock().catch((error) => {
        this.platform.log.warn(
          `Unable to refresh Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, delayMs);
  }

  updateMetadata(device: RoborockDevice): void {
    const duid = device.duid;
    const displayName =
      this.api.getVacuumDeviceInfo(duid, "name") ||
      device.name ||
      "Roborock Vacuum";

    this.accessory.displayName = displayName;
    // Some Matter layers label the node from `name` rather than `displayName`;
    // set both so Apple Home is less likely to show a generic name.
    this.accessory.name = displayName;
    this.accessory.manufacturer = "Roborock";
    this.accessory.model =
      this.api.getProductAttribute(duid, "model") ||
      this.api.getVacuumDeviceInfo(duid, "model") ||
      "Roborock Vacuum";
    this.accessory.serialNumber =
      this.api.getVacuumDeviceInfo(duid, "sn") || duid;
    const firmwareRevision = this.api.getVacuumDeviceInfo(duid, "fv");
    if (firmwareRevision) {
      this.accessory.firmwareRevision = firmwareRevision;
    } else {
      delete this.accessory.firmwareRevision;
    }
    this.accessory.context = { ...(this.accessory.context || {}), duid };
    this.accessory.clusters = this.buildClusters();
    this.accessory.handlers = this.buildHandlers();
    this.accessory.getState = async (cluster, attribute) => {
      const clusterState = this.buildCluster(cluster);
      this.scheduleMatterReadRefresh(cluster);
      return clusterState ? clusterState[attribute] : undefined;
    };
  }

  async notifyDeviceUpdater(id: string, data: unknown): Promise<void> {
    if (id === "HomeData" || id === "RoomMapping") {
      if (id === "HomeData") {
        this.rememberHomeDataStatus(data);
      }
      await this.updateMatterStateFromRoborock({
        includeStaticMetadata:
          id === "RoomMapping" && this.isServiceAreaEnabled(),
      });
      return;
    }

    if (id === "CloudMessage" || id === "LocalMessage") {
      const liveData = this.getLiveMessageForThisAccessory(data);
      if (liveData === null) {
        return;
      }

      await this.updateMatterStateFromMessage(liveData);
    }
  }

  async updateMatterStateFromRoborock(
    options: { includeStaticMetadata?: boolean } = {}
  ): Promise<void> {
    if (!this.registered) {
      return;
    }

    const matter = this.platform.getMatterApi();
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return;
    }

    const clusters = options.includeStaticMetadata
      ? this.buildClusters()
      : this.buildDynamicClusters();
    const force =
      !options.includeStaticMetadata &&
      this.isReadyStateForceRefreshDue(clusters);

    const updated = await this.updateMatterState(
      clusters,
      "Roborock state refresh",
      { force }
    );
    if (updated) {
      this.ensureMatterStateHeartbeat();
    }
    if (updated && force) {
      this.rememberReadyStateForceRefresh(clusters);
    }
  }

  private buildHandlers(): Record<string, Record<string, unknown>> {
    const handlers: Record<string, Record<string, unknown>> = {
      identify: {
        identify: async () => {
          await this.identifyVacuum();
        },
      },
      rvcRunMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeRunMode(request?.newMode);
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

    if (this.isCleanModeEnabled()) {
      handlers.rvcCleanMode = {
        changeToMode: async (request?: { newMode?: number }) => {
          await this.changeCleanMode(request?.newMode);
        },
      };
    }

    if (this.isServiceAreaEnabled()) {
      handlers.serviceArea = {
        selectAreas: async (request?: { newAreas?: unknown }) => {
          return await this.selectServiceAreas(request?.newAreas);
        },
      };
    }

    return handlers;
  }

  private async identifyVacuum(): Promise<void> {
    await this.publishCurrentMatterState("Matter identify command", true, {
      pulseIdentify: false,
    });

    const findMe = this.api.find_me;
    if (typeof findMe !== "function") {
      this.platform.log.debug(
        `Matter identify requested for ${this.getVacuumName()}, but the Roborock API does not expose find_me.`
      );
      return;
    }

    try {
      await findMe.call(
        this.api,
        this.getDuid(),
        this.getMatterCommandOptions()
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to locate ${this.getVacuumName()} from Matter identify: ${this.getErrorMessage(error)}`
      );
    }

    await this.publishCurrentMatterState(
      "Matter identify command complete",
      true,
      {
        pulseIdentify: false,
      }
    );
  }

  private async changeRunMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();
    const duid = this.getDuid();

    this.platform.log.info(
      `Matter run mode request for ${name}: ${newMode ?? "unknown"}.`
    );

    if (newMode === RUN_MODE_CLEANING) {
      const selectedAreas = this.getSelectedServiceAreaSegments();
      if (selectedAreas.length > 0) {
        const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas);
        const targetMapId = selectedMapIds[0] ?? null;
        // Roborock can only clean room segments from one map at a time. Service
        // area selection already constrains this to a single map, so this only
        // guards an unexpected multi-map selection by cleaning the first map
        // instead of throwing out of the Matter command handler.
        const areasToClean =
          selectedMapIds.length > 1
            ? selectedAreas.filter((area) => area.mapId === targetMapId)
            : selectedAreas;
        if (selectedMapIds.length > 1) {
          this.platform.log.warn(
            `Matter requested room cleaning across multiple Roborock maps for ${name}; cleaning only the areas on map ${targetMapId}.`
          );
        }

        const selectedAreaNames = areasToClean.map((area) =>
          this.formatServiceAreaName(area)
        );
        this.platform.log.info(
          `Starting ${name} from Matter for selected service area(s): ${selectedAreaNames.join(", ")}.`
        );
        const state = {
          rvcRunMode: { currentMode: RUN_MODE_CLEANING },
          rvcOperationalState: {
            operationalState: RVC_OPERATIONAL_STATE.RUNNING,
          },
        };
        this.setAndScheduleOptimisticState(state, "selected-area start");
        this.dispatchRoborockMatterCommand("service area clean", async () => {
          await this.applySelectedCleanModeIfNeeded();
          await this.loadMatterMapIfNeeded(duid, targetMapId);
          await this.api.app_segment_clean_by_ids(
            duid,
            areasToClean.map((area) => area.segmentId),
            this.getMatterCommandOptions()
          );
        });
        return;
      }

      this.platform.log.info(`Starting ${name} from Matter.`);
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_CLEANING },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.RUNNING,
        },
      };
      this.setAndScheduleOptimisticState(state, "start");
      this.dispatchRoborockMatterCommand("start", async () => {
        await this.applySelectedCleanModeIfNeeded();
        await this.api.app_start(duid, this.getMatterCommandOptions());
      });
      return;
    }

    if (newMode === RUN_MODE_IDLE) {
      this.platform.log.info(
        `Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`
      );
      const state = {
        rvcRunMode: { currentMode: RUN_MODE_IDLE },
        rvcOperationalState: {
          operationalState: RVC_OPERATIONAL_STATE.STOPPED,
        },
      };
      this.setAndScheduleOptimisticState(state, "stop");
      this.dispatchRoborockMatterCommand("stop", () =>
        this.api.app_stop(duid, this.getMatterCommandOptions())
      );
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter run mode '${newMode}' for ${name}.`
    );
  }

  private async changeCleanMode(newMode?: number): Promise<void> {
    const name = this.getVacuumName();

    this.platform.log.info(
      `Matter clean mode request for ${name}: ${newMode ?? "unknown"}.`
    );

    if (this.isSupportedCleanMode(newMode)) {
      this.rememberCurrentRoborockCleanModeSettings();
      this.selectedCleanMode = newMode;
      this.selectedCleanModeNeedsApply = true;
      const state = {
        rvcCleanMode: { currentMode: newMode },
      };
      this.setAndScheduleOptimisticState(state, "clean mode change");
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
    );
  }

  private async pauseCleaning(): Promise<void> {
    const roborockState = this.getNumberStatus("state");
    const chargeStatus = this.getNumberStatus("charge_status");
    const currentOperationalState = this.getOperationalState(
      roborockState,
      chargeStatus
    );
    if (
      this.isRoborockDockedOrCharging(roborockState, chargeStatus) ||
      (roborockState !== null &&
        !this.isInCleaningRunMode(currentOperationalState))
    ) {
      this.platform.log.info(
        `Ignoring Matter pause request for ${this.getVacuumName()} because it is not cleaning.`
      );
      await this.publishCurrentMatterState("ignored pause", true);
      return;
    }

    this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
    const state = {
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    };
    this.setAndScheduleOptimisticState(state, "pause");
    this.dispatchRoborockMatterCommand("pause", () =>
      this.api.app_pause(this.getDuid(), this.getMatterCommandOptions())
    );
  }

  private async resumeCleaning(): Promise<void> {
    this.platform.log.info(`Resuming ${this.getVacuumName()} from Matter.`);
    const state = {
      rvcRunMode: { currentMode: RUN_MODE_CLEANING },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.RUNNING,
      },
    };
    this.setAndScheduleOptimisticState(state, "resume");
    this.dispatchRoborockMatterCommand("resume", async () => {
      await this.applySelectedCleanModeIfNeeded();
      await this.api.app_start(this.getDuid(), this.getMatterCommandOptions());
    });
  }

  private async returnToDock(): Promise<void> {
    if (this.isDockedOrChargingNow() && !this.hasActiveOptimisticState()) {
      this.platform.log.info(
        `Ignoring Matter dock request for ${this.getVacuumName()} because it is already docked or charging.`
      );
      await this.publishCurrentMatterState(
        "return to dock already docked",
        true
      );
      return;
    }

    if (this.isDockedOrChargingNow()) {
      this.platform.log.info(
        `Sending ${this.getVacuumName()} back to dock from Matter despite a stale docked snapshot because a recent Matter command still expects active cleaning.`
      );
    }

    this.platform.log.info(
      `Sending ${this.getVacuumName()} back to dock from Matter.`
    );
    const returnOperationalState = this.isExtendedOperationalStateEnabled()
      ? RVC_OPERATIONAL_STATE.SEEKING_CHARGER
      : RVC_OPERATIONAL_STATE.STOPPED;
    const state = {
      rvcRunMode: {
        currentMode: this.isInCleaningRunMode(returnOperationalState)
          ? RUN_MODE_CLEANING
          : RUN_MODE_IDLE,
      },
      rvcOperationalState: {
        operationalState: returnOperationalState,
      },
    };
    this.setAndScheduleOptimisticState(state, "return to dock");
    this.dispatchRoborockMatterCommand("return to dock", () =>
      this.api.app_charge(this.getDuid(), this.getMatterCommandOptions())
    );
  }

  private scheduleMatterStateUpdate(
    partialClusters: MatterClusterState,
    reason: string,
    optimisticGeneration?: number
  ): void {
    if (!this.registered) {
      return;
    }

    scheduleTimer(() => {
      if (
        optimisticGeneration !== undefined &&
        optimisticGeneration !== this.optimisticGeneration
      ) {
        this.platform.log.debug(
          `Skipping stale Matter optimistic state update after ${reason} for ${this.getVacuumName()}.`
        );
        return;
      }

      void this.updateMatterState(partialClusters, reason)
        .then((updated) => {
          if (updated) {
            this.ensureMatterStateHeartbeat();
          }
        })
        .catch((error) => {
          this.platform.log.warn(
            `Unable to update Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
          );
        });
    }, 0);
  }

  private setAndScheduleOptimisticState(
    partialClusters: MatterClusterState,
    reason: string
  ): void {
    const optimisticGeneration = this.setOptimisticState(
      partialClusters,
      reason
    );
    this.scheduleMatterStateUpdate(
      this.optimisticClusters || partialClusters,
      reason,
      optimisticGeneration
    );
  }

  private async updateMatterState(
    partialClusters: Record<string, Record<string, unknown>>,
    reason = "state update",
    options: { force?: boolean } = {}
  ): Promise<boolean> {
    if (!this.registered) {
      return false;
    }

    const matter = this.platform.getMatterApi();
    if (!matter || typeof matter.updateAccessoryState !== "function") {
      return false;
    }

    const changedClusters = options.force
      ? partialClusters
      : this.filterChangedMatterAttributes(partialClusters);
    if (Object.keys(changedClusters).length === 0) {
      return false;
    }

    try {
      await Promise.all(
        Object.entries(changedClusters).map(([cluster, attributes]) =>
          matter.updateAccessoryState(this.accessory.UUID, cluster, attributes)
        )
      );
      this.rememberPublishedMatterAttributes(changedClusters);
      this.matterInitializationRetryAttempt = 0;
      this.matterInitializationRetryPending = false;
      return true;
    } catch (error) {
      if (this.isMatterInitializingError(error)) {
        this.scheduleMatterInitializationRetry(reason, error);
        return false;
      }

      throw error;
    }
  }

  private filterChangedMatterAttributes(
    partialClusters: MatterClusterState
  ): MatterClusterState {
    const changedClusters: MatterClusterState = {};

    Object.entries(partialClusters).forEach(([cluster, attributes]) => {
      const previouslyPublished =
        this.lastPublishedMatterAttributes.get(cluster);
      const changedAttributes: Record<string, unknown> = {};

      Object.entries(attributes).forEach(([attribute, value]) => {
        const serializedValue = this.serializeMatterValue(value);
        if (previouslyPublished?.get(attribute) !== serializedValue) {
          changedAttributes[attribute] = value;
        }
      });

      if (Object.keys(changedAttributes).length > 0) {
        changedClusters[cluster] = changedAttributes;
      }
    });

    return changedClusters;
  }

  private rememberPublishedMatterAttributes(
    partialClusters: MatterClusterState
  ): void {
    Object.entries(partialClusters).forEach(([cluster, attributes]) => {
      let publishedAttributes = this.lastPublishedMatterAttributes.get(cluster);
      if (!publishedAttributes) {
        publishedAttributes = new Map();
        this.lastPublishedMatterAttributes.set(cluster, publishedAttributes);
      }

      Object.entries(attributes).forEach(([attribute, value]) => {
        publishedAttributes.set(attribute, this.serializeMatterValue(value));
      });
    });
  }

  private serializeMatterValue(value: unknown): string {
    try {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? String(value) : serialized;
    } catch {
      return String(value);
    }
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

    // Remember the freshest live values so a later full cluster rebuild reflects
    // them instead of the slower HomeData snapshot.
    this.rememberLiveStatus("state", state);
    this.rememberLiveStatus("charge_status", chargeStatus);
    this.rememberLiveStatus("battery", battery);

    const clusters: MatterClusterState = {};

    if (state !== null || chargeStatus !== null) {
      const operationalState = this.getOperationalState(state, chargeStatus);
      const suppressState = this.shouldSuppressLiveState(
        operationalState,
        state,
        chargeStatus
      );

      if (!suppressState) {
        clusters.rvcRunMode = {
          currentMode: this.isInCleaningRunMode(operationalState)
            ? RUN_MODE_CLEANING
            : RUN_MODE_IDLE,
        };
        clusters.rvcOperationalState = {
          operationalState,
          currentPhase: this.currentMatterRefreshPhase,
        };
      }
    }

    if (battery !== null) {
      this.addPowerSourceCluster(clusters, battery, chargeStatus, state);
    }

    if (Object.keys(clusters).length > 0) {
      const force = this.isReadyStateForceRefreshDue(
        clusters,
        state,
        chargeStatus
      );
      const updated = await this.updateMatterState(clusters, "live state", {
        force,
      });
      if (updated) {
        this.ensureMatterStateHeartbeat();
      }
      if (updated && force) {
        this.rememberReadyStateForceRefresh(clusters);
      }
    }
  }

  private buildClusters(): MatterClusterState {
    const clusters: MatterClusterState = {
      rvcRunMode: this.buildRunModeCluster(),
      rvcOperationalState: this.buildOperationalStateCluster(),
    };

    this.addCleanModeCluster(clusters);
    this.addPowerSourceCluster(clusters);

    if (this.isServiceAreaEnabled()) {
      clusters.serviceArea = this.buildServiceAreaCluster();
    }

    return this.applyOptimisticState(clusters);
  }

  private buildDynamicClusters(): MatterClusterState {
    const operationalState = this.getOperationalState();
    const clusters: MatterClusterState = {
      rvcRunMode: {
        currentMode: this.isInCleaningRunMode(operationalState)
          ? RUN_MODE_CLEANING
          : RUN_MODE_IDLE,
      },
      rvcOperationalState: {
        operationalState,
        currentPhase: this.currentMatterRefreshPhase,
        operationalError: {
          errorStateId:
            operationalState === RVC_OPERATIONAL_STATE.ERROR
              ? RVC_ERROR_STATE.UNABLE_TO_COMPLETE_OPERATION
              : RVC_ERROR_STATE.NO_ERROR,
        },
      },
    };

    if (this.isCleanModeEnabled()) {
      clusters.rvcCleanMode = { currentMode: this.getCurrentCleanMode() };
    }

    this.addPowerSourceCluster(clusters);

    return this.applyOptimisticState(clusters);
  }

  private buildCluster(cluster: string): Record<string, unknown> | undefined {
    let clusterState: Record<string, unknown> | undefined;

    switch (cluster) {
      case "rvcRunMode":
        clusterState = this.buildRunModeCluster();
        break;
      case "rvcCleanMode":
        clusterState = this.isCleanModeEnabled()
          ? this.buildCleanModeCluster()
          : undefined;
        break;
      case "rvcOperationalState":
        clusterState = this.buildOperationalStateCluster();
        break;
      case "powerSource":
        clusterState = this.isPowerSourceEnabled()
          ? this.buildPowerSourceCluster()
          : undefined;
        break;
      case "serviceArea":
        clusterState = this.isServiceAreaEnabled()
          ? this.buildServiceAreaCluster()
          : undefined;
        break;
      default:
        return undefined;
    }

    if (!clusterState) {
      return undefined;
    }

    const optimisticCluster = this.getActiveOptimisticState()?.[cluster];
    return optimisticCluster
      ? { ...clusterState, ...optimisticCluster }
      : clusterState;
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
      supportedModes: this.getSupportedCleanModes(),
      currentMode: this.getCurrentCleanMode(),
    };
  }

  private getSupportedCleanModes(): Array<Record<string, unknown>> {
    const supportedModes: Array<Record<string, unknown>> = [
      {
        label: "Vacuum",
        mode: CLEAN_MODE_VACUUM,
        modeTags: [{ value: RVC_CLEAN_MODE_TAG_VACUUM }],
      },
    ];

    if (this.getMatterCleanModeCapabilities().canMop) {
      supportedModes.push(
        {
          label: "Mop",
          mode: CLEAN_MODE_MOP,
          modeTags: [{ value: RVC_CLEAN_MODE_TAG_MOP }],
        },
        {
          // Matter has no dedicated "vacuum then mop" tag, so combine the two
          // standard RVC Clean Mode tags instead of an undefined tag value.
          label: "Vacuum + Mop",
          mode: CLEAN_MODE_VACUUM_AND_MOP,
          modeTags: [
            { value: RVC_CLEAN_MODE_TAG_VACUUM },
            { value: RVC_CLEAN_MODE_TAG_MOP },
          ],
        }
      );
    }

    return supportedModes;
  }

  private getCurrentCleanMode(): number {
    return this.isSupportedCleanMode(this.selectedCleanMode)
      ? this.selectedCleanMode
      : CLEAN_MODE_VACUUM;
  }

  private isSupportedCleanMode(mode?: number): mode is number {
    return this.getSupportedCleanModes().some(
      (supportedMode) => supportedMode.mode === mode
    );
  }

  private getMatterCleanModeCapabilities(): MatterCleanModeCapabilities {
    const getCapabilities = this.api.getMatterCleanModeCapabilities;

    if (typeof getCapabilities !== "function") {
      return { canVacuum: true, canMop: false };
    }

    return getCapabilities.call(
      this.api,
      this.getDuid()
    ) as MatterCleanModeCapabilities;
  }

  private async applySelectedCleanModeIfNeeded(): Promise<void> {
    if (!this.selectedCleanModeNeedsApply) {
      return;
    }

    const applySettings = this.api.applyMatterCleanModeSettings;
    if (typeof applySettings !== "function") {
      this.selectedCleanModeNeedsApply = false;
      return;
    }

    const settings = this.getRoborockCleanModeSettings(
      this.getCurrentCleanMode()
    );
    if (!settings) {
      this.selectedCleanModeNeedsApply = false;
      return;
    }

    this.platform.log.info(
      `Applying ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting.`
    );
    try {
      await this.withCleanModePrepTimeout(
        applySettings.call(
          this.api,
          this.getDuid(),
          settings,
          this.getMatterCleanModePrepCommandOptions()
        )
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to apply ${this.getCleanModeLabel(this.getCurrentCleanMode())} mode to ${this.getVacuumName()} before starting; continuing with the start command. ${this.getErrorMessage(error)}`
      );
    } finally {
      this.selectedCleanModeNeedsApply = false;
    }
  }

  private async withCleanModePrepTimeout<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof nodeSetTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = scheduleTimer(() => {
        reject(
          new Error(
            `Matter clean mode prep timed out after ${MATTER_CLEAN_MODE_PREP_TIMEOUT_MS} ms.`
          )
        );
      }, MATTER_CLEAN_MODE_PREP_TIMEOUT_MS);
      unrefTimer(timeout);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimer(timeout);
      }
    }
  }

  private getRoborockCleanModeSettings(
    cleanMode: number
  ): RoborockCleanModeSettings | null {
    const capabilities = this.getMatterCleanModeCapabilities();
    const settings: RoborockCleanModeSettings = {};

    if (capabilities.canControlFanPower) {
      settings.fanPower =
        cleanMode === CLEAN_MODE_MOP
          ? ROBOROCK_FAN_POWER_OFF
          : this.getPreferredVacuumFanPower();
    }

    if (capabilities.canControlWater) {
      settings.waterBoxMode =
        cleanMode === CLEAN_MODE_VACUUM
          ? ROBOROCK_WATER_BOX_OFF
          : this.getPreferredWaterBoxMode();
    }

    return Object.keys(settings).length > 0 ? settings : null;
  }

  private rememberCurrentRoborockCleanModeSettings(): void {
    const fanPower = this.getNumberStatus("fan_power");
    if (fanPower !== null && fanPower !== ROBOROCK_FAN_POWER_OFF) {
      this.lastVacuumFanPower = fanPower;
    }

    const waterBoxMode =
      this.getNumberStatus("water_box_custom_mode") ??
      this.getNumberStatus("water_box_mode");
    if (waterBoxMode !== null && waterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
      this.lastWaterBoxMode = waterBoxMode;
    }
  }

  private getPreferredVacuumFanPower(): number {
    const currentFanPower = this.getNumberStatus("fan_power");
    if (
      currentFanPower !== null &&
      currentFanPower !== ROBOROCK_FAN_POWER_OFF
    ) {
      this.lastVacuumFanPower = currentFanPower;
      return currentFanPower;
    }

    return this.lastVacuumFanPower ?? ROBOROCK_FAN_POWER_BALANCED;
  }

  private getPreferredWaterBoxMode(): number {
    const currentWaterBoxMode =
      this.getNumberStatus("water_box_custom_mode") ??
      this.getNumberStatus("water_box_mode");
    if (
      currentWaterBoxMode !== null &&
      currentWaterBoxMode !== ROBOROCK_WATER_BOX_OFF
    ) {
      this.lastWaterBoxMode = currentWaterBoxMode;
      return currentWaterBoxMode;
    }

    return this.lastWaterBoxMode ?? ROBOROCK_WATER_BOX_MILD;
  }

  private getCleanModeLabel(cleanMode: number): string {
    switch (cleanMode) {
      case CLEAN_MODE_MOP:
        return "Mop";
      case CLEAN_MODE_VACUUM_AND_MOP:
        return "Vacuum + Mop";
      default:
        return "Vacuum";
    }
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
      phaseList: [...RVC_OPERATIONAL_PHASE_LIST],
      currentPhase: this.currentMatterRefreshPhase,
      // Advertise operational state IDs without labels. Apple Home stops
      // commissioning ("Connecting" forever) when the list carries labels or
      // manufacturer-range IDs, so only bare IDs are exposed here.
      operationalStateList: this.getOperationalStateList().map(
        (operationalStateId) => ({ operationalStateId })
      ),
      operationalState,
      operationalError,
    };
  }

  private buildPowerSourceCluster(
    batteryValue?: number,
    chargeStatusValue?: number | null,
    stateValue?: number | null
  ): Record<string, unknown> {
    const battery =
      batteryValue === undefined
        ? this.getNumberStatus("battery")
        : batteryValue;
    const chargeStatus =
      chargeStatusValue === undefined
        ? this.getNumberStatus("charge_status")
        : chargeStatusValue;
    const state =
      stateValue === undefined ? this.getNumberStatus("state") : stateValue;
    const normalizedBattery =
      battery === null ? null : Math.max(0, Math.min(100, battery));

    return {
      status:
        normalizedBattery === null
          ? POWER_SOURCE_STATUS.UNAVAILABLE
          : POWER_SOURCE_STATUS.ACTIVE,
      order: 0,
      description: "Roborock vacuum battery",
      batPresent: normalizedBattery !== null,
      batPercentRemaining:
        normalizedBattery === null ? null : normalizedBattery * 2,
      batChargeLevel: this.getBatteryChargeLevel(normalizedBattery),
      batChargeState: this.getBatteryChargeState(
        normalizedBattery,
        chargeStatus,
        state
      ),
      batReplacementNeeded: false,
    };
  }

  private addPowerSourceCluster(
    clusters: MatterClusterState,
    batteryValue?: number,
    chargeStatusValue?: number | null,
    stateValue?: number | null
  ): void {
    if (!this.isPowerSourceEnabled()) {
      return;
    }

    clusters.powerSource = this.buildPowerSourceCluster(
      batteryValue,
      chargeStatusValue,
      stateValue
    );
  }

  private addCleanModeCluster(clusters: MatterClusterState): void {
    if (!this.isCleanModeEnabled()) {
      return;
    }

    clusters.rvcCleanMode = this.buildCleanModeCluster();
  }

  private buildServiceAreaCluster(): Record<string, unknown> {
    const areas = this.getMatterServiceAreas();
    const supportedMaps = this.getMatterServiceAreaMaps(areas);
    const includeMapNamesInAreaLabels = supportedMaps.length > 1;
    const supportedAreaIds = new Set(areas.map((area) => area.areaId));
    const selectedAreas = this.selectedServiceAreaIds.filter((areaId) =>
      supportedAreaIds.has(areaId)
    );

    if (selectedAreas.length !== this.selectedServiceAreaIds.length) {
      this.selectedServiceAreaIds = selectedAreas;
    }

    this.logMatterServiceAreaSummary(areas, supportedMaps);

    const state: Record<string, unknown> = {
      supportedAreas: areas.map((area) => ({
        areaId: area.areaId,
        mapId: area.mapId,
        areaInfo: {
          locationInfo: {
            locationName: this.getMatterLocationDisplayName(
              area,
              includeMapNamesInAreaLabels
            ),
            floorNumber: null,
            areaType: null,
          },
          landmarkInfo: null,
        },
      })),
      selectedAreas,
    };

    if (supportedMaps.length > 0) {
      state.supportedMaps = supportedMaps;
    }

    return state;
  }

  private async selectServiceAreas(
    newAreas?: unknown
  ): Promise<Record<string, unknown>> {
    const supportedAreas = new Map(
      this.getMatterServiceAreas().map((area) => [area.areaId, area])
    );
    const selectedAreas = this.normalizeMatterAreaIds(newAreas);
    const unsupportedArea = selectedAreas.find(
      (areaId) => !supportedAreas.has(areaId)
    );

    this.platform.log.info(
      `Matter service area selection request for ${this.getVacuumName()}: ${selectedAreas.join(", ") || "none"}.`
    );

    if (unsupportedArea !== undefined) {
      return {
        status: SERVICE_AREA_SELECT_STATUS.UNSUPPORTED_AREA,
        statusText: `Area ${unsupportedArea} is not available from the Roborock room map.`,
      };
    }

    const selectedMapIds = this.getSelectedServiceAreaMapIds(
      selectedAreas
        .map((areaId) => supportedAreas.get(areaId))
        .filter((area): area is MatterServiceArea => area !== undefined)
    );
    if (selectedMapIds.length > 1) {
      this.platform.log.warn(
        `Ignoring Matter service area selection spanning multiple Roborock maps for ${this.getVacuumName()}; select areas from one map at a time.`
      );
      return {
        status: SERVICE_AREA_SELECT_STATUS.INVALID_SET,
        statusText:
          "Select service areas from only one Roborock map at a time.",
      };
    }

    this.selectedServiceAreaIds = selectedAreas;
    if (selectedAreas.length > 0) {
      const areaNames = selectedAreas
        .map((areaId) => supportedAreas.get(areaId))
        .filter((area): area is MatterServiceArea => area !== undefined)
        .map((area) => this.formatServiceAreaName(area));
      this.platform.log.info(
        `Selected Matter service area(s) for ${this.getVacuumName()}: ${areaNames.join(", ")}.`
      );
    } else {
      this.platform.log.info(
        `Cleared Matter service area selection for ${this.getVacuumName()}.`
      );
    }

    this.scheduleMatterStateUpdate(
      {
        serviceArea: this.buildServiceAreaCluster(),
      },
      "service area selection"
    );

    return {
      status: SERVICE_AREA_SELECT_STATUS.SUCCESS,
      statusText: "",
    };
  }

  private getMatterServiceAreas(): MatterServiceArea[] {
    const getRoomMappingsForDevice = this.api.getRoomMappingsForDevice;
    if (typeof getRoomMappingsForDevice !== "function") {
      return [];
    }

    const rooms = getRoomMappingsForDevice.call(this.api, this.getDuid());
    if (!Array.isArray(rooms)) {
      return [];
    }

    const areas: MatterServiceArea[] = [];
    const mapsById = new Map(
      this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map])
    );
    const seenAreaIds = new Set<number>();
    for (const room of rooms) {
      const roomRecord = this.asRecord(room);
      const segmentId = this.getNumberFromValue(roomRecord?.segmentId);
      const mapId = this.getMatterMapId(roomRecord?.mapId);
      const areaId =
        segmentId === null
          ? null
          : this.getMatterAreaId(segmentId, mapId, seenAreaIds);
      if (
        areaId === null ||
        segmentId === null ||
        !Number.isInteger(segmentId) ||
        segmentId < 0 ||
        seenAreaIds.has(areaId)
      ) {
        continue;
      }

      seenAreaIds.add(areaId);
      areas.push({
        areaId,
        segmentId,
        mapId,
        mapName: mapId === null ? null : mapsById.get(mapId)?.name || null,
        name: this.toMatterLocationName(roomRecord?.name, segmentId),
      });
    }

    return areas;
  }

  private getMatterServiceAreaMaps(
    areas: MatterServiceArea[]
  ): MatterServiceAreaMap[] {
    // Matter controllers can hang if supportedMaps advertises maps with no
    // matching supportedAreas, or if supportedAreas reference a mapId that has
    // no supportedMaps entry. Build supportedMaps from exactly the maps that
    // have areas, preferring Roborock-reported map names and falling back to
    // the area's map name or a generated label.
    const roborockMapsById = new Map(
      this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map])
    );

    const maps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();

    for (const area of areas) {
      if (area.mapId === null || seenMapIds.has(area.mapId)) {
        continue;
      }

      seenMapIds.add(area.mapId);
      maps.push({
        mapId: area.mapId,
        name:
          roborockMapsById.get(area.mapId)?.name ||
          area.mapName ||
          `Roborock Map ${area.mapId}`,
      });
    }

    return maps;
  }

  private getMatterServiceAreaMapsFromRoborock(): MatterServiceAreaMap[] {
    const getMapListForDevice = this.api.getMapListForDevice;
    if (typeof getMapListForDevice !== "function") {
      return [];
    }

    const maps = getMapListForDevice.call(this.api, this.getDuid());
    if (!Array.isArray(maps)) {
      return [];
    }

    const supportedMaps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();
    for (const map of maps) {
      const mapRecord = this.asRecord(map);
      const mapId = this.getMatterMapId(mapRecord?.mapId);
      if (mapId === null || seenMapIds.has(mapId)) {
        continue;
      }

      seenMapIds.add(mapId);
      supportedMaps.push({
        mapId,
        name: this.toMatterMapName(mapRecord?.name, mapId),
      });
    }

    return supportedMaps;
  }

  private getMatterAreaId(
    segmentId: number,
    mapId: number | null,
    usedAreaIds: Set<number>
  ): number {
    let areaId =
      mapId === null
        ? segmentId
        : mapId * MATTER_AREA_ID_MAP_MULTIPLIER + segmentId;

    if (!Number.isSafeInteger(areaId) || areaId > MATTER_AREA_ID_MAX) {
      areaId = this.getHashedMatterAreaId(mapId, segmentId);
    }

    while (usedAreaIds.has(areaId)) {
      areaId = areaId >= MATTER_AREA_ID_MAX ? 0 : areaId + 1;
    }

    return areaId;
  }

  private getHashedMatterAreaId(
    mapId: number | null,
    segmentId: number
  ): number {
    const source = `${mapId ?? "none"}:${segmentId}`;
    let hash = 2166136261;

    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }

    return hash;
  }

  private getMatterMapId(value: unknown): number | null {
    const mapId = this.getNumberFromValue(value);

    return mapId !== null && Number.isInteger(mapId) && mapId >= 0
      ? mapId
      : null;
  }

  private logMatterServiceAreaSummary(
    areas: MatterServiceArea[],
    maps: MatterServiceAreaMap[]
  ): void {
    const summary = [
      this.getDuid(),
      areas
        .map((area) => `${area.areaId}:${area.mapId ?? "none"}:${area.name}`)
        .join("|"),
      maps.map((map) => `${map.mapId}:${map.name}`).join("|"),
    ].join(";");

    if (summary === this.lastServiceAreaSummary) {
      return;
    }

    this.lastServiceAreaSummary = summary;

    if (areas.length === 0) {
      this.platform.log.info(
        `Matter Service Area is enabled for ${this.getVacuumName()}, but no Roborock rooms are available to expose yet.`
      );
      return;
    }

    this.platform.log.info(
      `Matter Service Area for ${this.getVacuumName()}: exposing ${areas.length} room(s)` +
        `${maps.length > 0 ? ` on ${maps.length} map(s)` : ""}: ${areas
          .map((area) =>
            this.getMatterLocationDisplayName(area, maps.length > 1)
          )
          .join(", ")}.`
    );
  }

  private getSelectedServiceAreaSegments(): MatterServiceArea[] {
    if (!this.isServiceAreaEnabled()) {
      return [];
    }

    const areasById = new Map(
      this.getMatterServiceAreas().map((area) => [area.areaId, area])
    );
    return this.selectedServiceAreaIds
      .map((areaId) => areasById.get(areaId))
      .filter((area): area is MatterServiceArea => area !== undefined);
  }

  private normalizeMatterAreaIds(newAreas: unknown): number[] {
    if (!Array.isArray(newAreas)) {
      return [];
    }

    const selectedAreas: number[] = [];
    const seenAreaIds = new Set<number>();
    for (const area of newAreas) {
      const areaId = this.getNumberFromValue(area);
      if (
        areaId === null ||
        !Number.isInteger(areaId) ||
        areaId < 0 ||
        seenAreaIds.has(areaId)
      ) {
        continue;
      }

      seenAreaIds.add(areaId);
      selectedAreas.push(areaId);
    }

    return selectedAreas;
  }

  private clampMatterName(
    name: unknown,
    maxLength: number,
    fallback: string
  ): string {
    const normalizedName =
      typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    const value = normalizedName || fallback;

    return value.length > maxLength
      ? value.slice(0, maxLength).trim() || fallback
      : value;
  }

  private toMatterLocationName(name: unknown, areaId: number): string {
    return this.clampMatterName(
      name,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      `Room ${areaId}`
    );
  }

  private toMatterMapName(name: unknown, mapId: number): string {
    return this.clampMatterName(
      name,
      MATTER_MAP_NAME_MAX_LENGTH,
      `Roborock Map ${mapId}`
    );
  }

  private formatServiceAreaName(area: MatterServiceArea): string {
    return area.mapName ? `${area.name} (${area.mapName})` : area.name;
  }

  private getMatterLocationDisplayName(
    area: MatterServiceArea,
    includeMapName: boolean
  ): string {
    if (!includeMapName || !area.mapName) {
      return area.name;
    }

    const fallbackName = this.clampMatterName(
      `${area.mapName} - Room ${area.segmentId}`,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      area.name
    );

    return this.clampMatterName(
      `${area.mapName} - ${area.name}`,
      MATTER_LOCATION_NAME_MAX_LENGTH,
      fallbackName
    );
  }

  private getSelectedServiceAreaMapIds(
    selectedAreas: MatterServiceArea[]
  ): number[] {
    const selectedMapIds = new Set<number>();
    for (const area of selectedAreas) {
      if (area.mapId !== null) {
        selectedMapIds.add(area.mapId);
      }
    }

    return Array.from(selectedMapIds);
  }

  private async loadMatterMapIfNeeded(
    duid: string,
    targetMapId: number | null
  ): Promise<void> {
    if (targetMapId === null) {
      return;
    }

    const currentMapId = this.getCurrentMatterMapId();
    if (currentMapId === targetMapId) {
      return;
    }

    const loadMap = this.api.load_multi_map;
    if (typeof loadMap !== "function") {
      throw new Error(
        `Roborock map ${targetMapId} is not currently loaded and this plugin cannot switch maps.`
      );
    }

    this.platform.log.info(
      `Loading Roborock map ${targetMapId} for ${this.getVacuumName()} before selected-area cleaning.`
    );
    try {
      await loadMap.call(
        this.api,
        duid,
        targetMapId,
        this.getMatterMapLoadCommandOptions()
      );
    } catch (error) {
      const currentMapIdAfterError = this.getCurrentMatterMapId();
      if (currentMapIdAfterError === targetMapId) {
        this.platform.log.warn(
          `Roborock map ${targetMapId} for ${this.getVacuumName()} became active even though the map-load acknowledgement failed: ${this.getErrorMessage(error)}`
        );
        return;
      }

      throw error;
    }
  }

  private getCurrentMatterMapId(): number | null {
    const getCurrentMapIdForDevice = this.api.getCurrentMapIdForDevice;
    if (typeof getCurrentMapIdForDevice !== "function") {
      return null;
    }

    const currentMapId = getCurrentMapIdForDevice.call(
      this.api,
      this.getDuid()
    );

    return this.getMatterMapId(currentMapId);
  }

  private isServiceAreaEnabled(): boolean {
    return (
      Boolean(this.platform.platformConfig.enableMatter) &&
      this.platform.platformConfig.enableMatterServiceArea !== false
    );
  }

  private isPowerSourceEnabled(): boolean {
    return this.platform.platformConfig.enableMatterPowerSource !== false;
  }

  private isCleanModeEnabled(): boolean {
    return this.platform.platformConfig.enableMatterCleanMode !== false;
  }

  private isExtendedOperationalStateEnabled(): boolean {
    return (
      this.platform.platformConfig.enableMatterExtendedOperationalStates ===
      true
    );
  }

  private getOperationalStateList(): readonly number[] {
    return this.isExtendedOperationalStateEnabled()
      ? RVC_OPERATIONAL_STATE_LIST
      : RVC_BASIC_OPERATIONAL_STATE_LIST;
  }

  private getBatteryChargeLevel(battery: number | null): number {
    if (battery !== null && battery <= 10) {
      return BATTERY_CHARGE_LEVEL.CRITICAL;
    }

    if (battery !== null && battery < 20) {
      return BATTERY_CHARGE_LEVEL.WARNING;
    }

    return BATTERY_CHARGE_LEVEL.OK;
  }

  private getBatteryChargeState(
    battery: number | null,
    chargeStatus: number | null,
    state: number | null
  ): number {
    if (battery === null) {
      return BATTERY_CHARGE_STATE.UNKNOWN;
    }

    if (state === 100 || (battery >= 100 && chargeStatus !== 0)) {
      return BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE;
    }

    if (chargeStatus !== null) {
      return chargeStatus !== 0
        ? BATTERY_CHARGE_STATE.IS_CHARGING
        : BATTERY_CHARGE_STATE.IS_NOT_CHARGING;
    }

    if (state === 8) {
      return BATTERY_CHARGE_STATE.IS_CHARGING;
    }

    return BATTERY_CHARGE_STATE.UNKNOWN;
  }

  private getOperationalState(
    state = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): number {
    const operationalState = this.getRoborockOperationalState(
      state,
      chargeStatus
    );

    return this.toControllerOperationalState(operationalState);
  }

  private getRoborockOperationalState(
    state: number | null,
    chargeStatus: number | null
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

  private toControllerOperationalState(operationalState: number): number {
    if (
      this.isExtendedOperationalStateEnabled() &&
      operationalState === RVC_OPERATIONAL_STATE.SEEKING_CHARGER
    ) {
      return operationalState;
    }

    switch (operationalState) {
      case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
        return RVC_OPERATIONAL_STATE.STOPPED;
      case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
      case RVC_OPERATIONAL_STATE.CLEANING_MOP:
      case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
        return RVC_OPERATIONAL_STATE.RUNNING;
      case RVC_OPERATIONAL_STATE.CHARGING:
      case RVC_OPERATIONAL_STATE.DOCKED:
        return RVC_OPERATIONAL_STATE.STOPPED;
      default:
        return operationalState;
    }
  }

  private isInCleaningRunMode(operationalState: number): boolean {
    switch (operationalState) {
      case RVC_OPERATIONAL_STATE.RUNNING:
      case RVC_OPERATIONAL_STATE.PAUSED:
      case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
      case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
      case RVC_OPERATIONAL_STATE.CLEANING_MOP:
      case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
        return true;
      default:
        return false;
    }
  }

  private rememberLiveStatus(property: string, value: number | null): void {
    if (value !== null) {
      this.liveStatus.set(property, value);
    }
  }

  private rememberHomeDataStatus(data: unknown): void {
    const message = this.asRecord(data);
    const value = message?.val;
    if (typeof value !== "string") {
      return;
    }

    let homeData: unknown;
    try {
      homeData = JSON.parse(value);
    } catch {
      return;
    }

    const home = this.asRecord(homeData);
    const devices = Array.isArray(home?.devices) ? home.devices : [];
    const device = devices
      .map((entry) => this.asRecord(entry))
      .find((entry) => entry?.duid === this.getDuid());
    const deviceStatus = this.asRecord(device?.deviceStatus);
    if (!deviceStatus) {
      return;
    }

    this.rememberLiveStatus(
      "state",
      this.getNumberFromValue(deviceStatus.state)
    );
    this.rememberLiveStatus(
      "battery",
      this.getNumberFromValue(deviceStatus.battery)
    );
    this.rememberLiveStatus(
      "charge_status",
      this.getNumberFromValue(deviceStatus.charge_status)
    );
  }

  private getNumberStatus(property: string): number | null {
    // Prefer the freshest value from a live message, falling back to the
    // HomeData snapshot for properties live messages do not carry.
    const liveValue = this.liveStatus.get(property);
    if (liveValue !== undefined) {
      return liveValue;
    }

    const value = this.api.getVacuumDeviceStatus(this.getDuid(), property);

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

  private getLiveMessageForThisAccessory(data: unknown): unknown | null {
    if (!data || typeof data !== "object") {
      return data;
    }

    if (Array.isArray(data)) {
      if (!this.platform.shouldAcceptUnscopedLiveMessage()) {
        this.platform.log.debug(
          `Ignoring unscoped live Roborock update for ${this.getVacuumName()} because multiple vacuums are configured.`
        );
        return null;
      }

      return data;
    }

    const message = data as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(message, "duid") &&
      Object.prototype.hasOwnProperty.call(message, "payload")
    ) {
      if (String(message.duid) !== this.getDuid()) {
        return null;
      }

      return message.payload;
    }

    return data;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  }

  private setOptimisticState(
    partialClusters: MatterClusterState,
    action: string
  ): number {
    this.optimisticClusters = this.mergeClusterState(
      this.getActiveOptimisticState() || {},
      partialClusters
    );
    this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_TTL_MS;
    this.optimisticGeneration += 1;
    this.optimisticAction = action;
    this.contradictingLiveStateCount = 0;

    return this.optimisticGeneration;
  }

  private shouldSuppressLiveState(
    operationalState: number,
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    const optimistic = this.getActiveOptimisticState();
    const expected = optimistic?.rvcOperationalState?.operationalState;

    if (typeof expected !== "number") {
      this.contradictingLiveStateCount = 0;
      return false;
    }

    if (
      this.doesLiveStateConfirmOptimisticState(
        expected,
        operationalState,
        roborockState,
        chargeStatus
      )
    ) {
      this.clearOptimisticState();
      return false;
    }

    // The command was acknowledged but the robot reports a different state.
    // Tolerate a couple of transitional reports, then trust the live state so
    // an optimistic value cannot stay stuck until the TTL expires (e.g. a start
    // the robot ignored because the bin is full or it is off the dock).
    this.contradictingLiveStateCount += 1;
    if (this.contradictingLiveStateCount >= OPTIMISTIC_CONTRADICTION_LIMIT) {
      this.platform.log.debug(
        `Clearing optimistic Matter state for ${this.getVacuumName()} after ${this.contradictingLiveStateCount} contradicting Roborock updates (expected ${expected}, got ${operationalState}).`
      );
      this.clearOptimisticState();
      return false;
    }

    return true;
  }

  private doesLiveStateConfirmOptimisticState(
    expected: number,
    actual: number,
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    if (expected === actual) {
      return true;
    }

    if (
      this.optimisticAction === "return to dock" &&
      expected === RVC_OPERATIONAL_STATE.RUNNING &&
      !this.isInCleaningRunMode(actual) &&
      this.isRoborockDockedOrCharging(roborockState, chargeStatus)
    ) {
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

  private isRoborockDockedOrCharging(
    roborockState: number | null,
    chargeStatus: number | null
  ): boolean {
    return roborockState === 8 || roborockState === 100 || !!chargeStatus;
  }

  private isDockedOrChargingNow(): boolean {
    return this.isRoborockDockedOrCharging(
      this.getNumberStatus("state"),
      this.getNumberStatus("charge_status")
    );
  }

  private async publishCurrentMatterState(
    reason: string,
    force = false,
    options: { pulseIdentify?: boolean } = {}
  ): Promise<void> {
    this.clearOptimisticState();
    if (force) {
      this.rotateMatterRefreshPhase();
    }
    const clusters = this.buildDynamicClusters();
    const updated = await this.updateMatterState(clusters, reason, { force });
    if (updated) {
      this.ensureMatterStateHeartbeat();
    }
    if (updated && force) {
      this.rememberReadyStateForceRefresh(clusters);
      if (options.pulseIdentify === true) {
        this.pulseMatterIdentifyRefresh(reason);
      }
    }
  }

  private pulseMatterIdentifyRefresh(reason: string): void {
    void this.updateMatterState(
      {
        identify: {
          identifyTime: MATTER_READY_IDENTIFY_REFRESH_SECONDS,
        },
      },
      `${reason} HomeKit refresh pulse`,
      { force: true }
    ).catch((error) => {
      this.platform.log.debug(
        `Unable to pulse Matter identify state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
      );
    });

    const clearTimer = scheduleTimer(() => {
      void this.updateMatterState(
        {
          identify: {
            identifyTime: 0,
          },
        },
        `${reason} HomeKit refresh pulse clear`,
        { force: true }
      ).catch((error) => {
        this.platform.log.debug(
          `Unable to clear Matter identify pulse after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, MATTER_READY_IDENTIFY_REFRESH_CLEAR_MS);
    unrefTimer(clearTimer);
  }

  private scheduleMatterReadRefresh(cluster: string): void {
    if (!this.registered || !this.isMatterReadRefreshCluster(cluster)) {
      return;
    }

    const clusters = this.buildDynamicClusters();
    if (!this.hasDynamicMatterState(clusters)) {
      return;
    }

    if (
      Date.now() - this.lastMatterReadRefreshAt <
      MATTER_READY_READ_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    this.lastMatterReadRefreshAt = Date.now();
    const refreshTimer = scheduleTimer(() => {
      void this.publishCurrentMatterState("HomeKit state read", true, {
        pulseIdentify: false,
      }).catch((error) => {
        this.platform.log.debug(
          `Unable to refresh Matter state after HomeKit read for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, 0);
    unrefTimer(refreshTimer);
  }

  private isMatterReadRefreshCluster(cluster: string): boolean {
    return (
      cluster === "rvcRunMode" ||
      cluster === "rvcOperationalState" ||
      cluster === "rvcCleanMode" ||
      cluster === "identify"
    );
  }

  private isReadyStateForceRefreshDue(
    clusters: MatterClusterState,
    roborockState = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): boolean {
    if (!MATTER_READY_FORCE_REFRESH_ENABLED) {
      return false;
    }

    if (!this.isReadyMatterState(clusters, roborockState, chargeStatus)) {
      return false;
    }

    return (
      Date.now() - this.lastMatterReadyForceRefreshAt >=
      MATTER_READY_FORCE_REFRESH_INTERVAL_MS
    );
  }

  private rememberReadyStateForceRefresh(
    clusters: MatterClusterState,
    roborockState = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): void {
    if (this.isReadyMatterState(clusters, roborockState, chargeStatus)) {
      this.lastMatterReadyForceRefreshAt = Date.now();
      this.ensureMatterStateHeartbeat();
    }
  }

  private pulseMatterIdentifyRefreshForActiveState(
    clusters: MatterClusterState,
    reason: string
  ): void {
    if (!this.isActiveMatterState(clusters)) {
      return;
    }

    this.ensureMatterActiveIdentifyRefresh();

    if (
      Date.now() - this.lastMatterActiveIdentifyRefreshAt <
      MATTER_ACTIVE_IDENTIFY_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    this.lastMatterActiveIdentifyRefreshAt = Date.now();
    this.pulseMatterIdentifyRefresh(reason);
  }

  private ensureMatterActiveIdentifyRefresh(): void {
    if (!this.registered || this.matterActiveIdentifyRefreshTimer) {
      return;
    }

    const refreshTimer = scheduleTimer(() => {
      this.matterActiveIdentifyRefreshTimer = null;

      const clusters = this.buildDynamicClusters();
      if (!this.isActiveMatterState(clusters)) {
        return;
      }

      this.pulseMatterIdentifyRefreshForActiveState(
        clusters,
        "active state timer"
      );
    }, MATTER_ACTIVE_IDENTIFY_REFRESH_INTERVAL_MS);
    this.matterActiveIdentifyRefreshTimer = refreshTimer;
    unrefTimer(refreshTimer);
  }

  private ensureMatterStateHeartbeat(): void {
    if (
      !MATTER_STATE_HEARTBEAT_ENABLED ||
      !this.registered ||
      this.matterStateHeartbeatTimer
    ) {
      return;
    }

    const heartbeatTimer = scheduleTimer(() => {
      this.matterStateHeartbeatTimer = null;

      const clusters = this.buildDynamicClusters();
      if (!this.isHeartbeatMatterState(clusters)) {
        return;
      }

      void this.publishCurrentMatterState("Matter state heartbeat", true, {
        pulseIdentify: false,
      }).catch((error) => {
        this.platform.log.debug(
          `Unable to publish Matter state heartbeat for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, MATTER_STATE_HEARTBEAT_INTERVAL_MS);
    this.matterStateHeartbeatTimer = heartbeatTimer;
    unrefTimer(heartbeatTimer);
  }

  private isHeartbeatMatterState(clusters: MatterClusterState): boolean {
    return this.isActiveMatterState(clusters);
  }

  private rotateMatterRefreshPhase(): void {
    this.currentMatterRefreshPhase =
      this.currentMatterRefreshPhase === RVC_OPERATIONAL_PHASE_PRIMARY
        ? RVC_OPERATIONAL_PHASE_REFRESH
        : RVC_OPERATIONAL_PHASE_PRIMARY;
  }

  private hasDynamicMatterState(clusters: MatterClusterState): boolean {
    return (
      typeof clusters.rvcRunMode?.currentMode === "number" &&
      typeof clusters.rvcOperationalState?.operationalState === "number"
    );
  }

  private isActiveMatterState(clusters: MatterClusterState): boolean {
    const operationalState = this.getNumberFromValue(
      clusters.rvcOperationalState?.operationalState
    );

    return (
      clusters.rvcRunMode?.currentMode === RUN_MODE_CLEANING ||
      (operationalState !== null && this.isInCleaningRunMode(operationalState))
    );
  }

  private hasActiveOptimisticState(): boolean {
    const optimistic = this.getActiveOptimisticState();
    return optimistic !== null && this.isActiveMatterState(optimistic);
  }

  private pulseMatterIdentifyRefreshForReadyState(
    clusters: MatterClusterState,
    reason: string
  ): void {
    if (!this.isReadyMatterState(clusters)) {
      return;
    }

    if (
      Date.now() - this.lastMatterReadyIdentifyRefreshAt <
      MATTER_READY_IDENTIFY_REFRESH_INTERVAL_MS
    ) {
      return;
    }

    this.lastMatterReadyIdentifyRefreshAt = Date.now();
    this.pulseMatterIdentifyRefresh(reason);
  }

  private isReadyMatterState(
    clusters: MatterClusterState,
    roborockState = this.getNumberStatus("state"),
    chargeStatus = this.getNumberStatus("charge_status")
  ): boolean {
    return (
      clusters.rvcRunMode?.currentMode === RUN_MODE_IDLE &&
      clusters.rvcOperationalState?.operationalState ===
        RVC_OPERATIONAL_STATE.STOPPED &&
      this.isRoborockDockedOrCharging(roborockState, chargeStatus)
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
    this.optimisticAction = null;
    this.optimisticGeneration += 1;
    this.contradictingLiveStateCount = 0;
  }

  private dispatchRoborockMatterCommand(
    action: string,
    command: () => Promise<void>
  ): void {
    const startedAt = Date.now();

    void command()
      .then(() => {
        this.logMatterCommandDuration(action, startedAt);
        this.schedulePostCommandStatusRefresh(action);
      })
      .catch(async (error) => {
        if (this.isMatterCommandTimeoutError(error)) {
          this.platform.log.warn(
            `Matter ${action} command for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`
          );
          this.schedulePostCommandStatusRefresh(action, {
            acknowledgementTimedOut: true,
          });
          return;
        }

        this.platform.log.error(
          `Error sending Matter ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
        await this.recoverMatterStateAfterFailedCommand(action);
      });
  }

  private async recoverMatterStateAfterFailedCommand(
    action: string
  ): Promise<void> {
    this.clearOptimisticState();

    const recoveryState: MatterClusterState = {
      rvcRunMode: this.buildRunModeCluster(),
      rvcOperationalState: this.buildOperationalStateCluster(),
    };
    this.addPowerSourceCluster(recoveryState);

    try {
      await this.updateMatterState(
        recoveryState,
        `${action} command failure recovery`
      );
    } catch (error) {
      this.platform.log.warn(
        `Unable to recover Matter state after failed ${action} command for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
      );
    }
  }

  private isMatterCommandTimeoutError(error: unknown): boolean {
    return /timed out after \d+ seconds/.test(this.getErrorMessage(error));
  }

  private isMatterInitializingError(error: unknown): boolean {
    return /\bis still initializing\b/i.test(this.getErrorMessage(error));
  }

  private scheduleMatterInitializationRetry(
    reason: string,
    error: unknown
  ): void {
    if (this.matterInitializationRetryPending) {
      return;
    }

    const delayMs =
      MATTER_INITIALIZATION_RETRY_DELAYS_MS[
        this.matterInitializationRetryAttempt
      ];
    if (delayMs === undefined) {
      this.platform.log.debug(
        `Matter state update after ${reason} for ${this.getVacuumName()} is still waiting on Homebridge endpoint initialization; suppressing additional startup retries. Last error: ${this.getErrorMessage(error)}`
      );
      return;
    }

    this.matterInitializationRetryAttempt += 1;
    this.matterInitializationRetryPending = true;
    this.platform.log.debug(
      `Matter state update after ${reason} for ${this.getVacuumName()} was delayed because Homebridge says the endpoint is still initializing; retrying in ${delayMs} ms.`
    );

    scheduleTimer(() => {
      this.matterInitializationRetryPending = false;
      this.scheduleMatterStateRefresh(
        `endpoint initialization retry (${reason})`
      );
    }, delayMs);
  }

  private logMatterCommandDuration(action: string, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    const transport = this.getTransportDescription();
    const message =
      `Matter ${action} command for ${this.getVacuumName()} was acknowledged ` +
      `by Roborock in ${durationMs} ms${transport ? ` via ${transport}` : ""}.`;

    if (durationMs >= SLOW_MATTER_COMMAND_MS) {
      this.platform.log.warn(`Slow ${message}`);
      return;
    }

    this.platform.log.info(message);
  }

  private schedulePostCommandStatusRefresh(
    action: string,
    options: { acknowledgementTimedOut?: boolean } = {}
  ): void {
    const refreshStatus = this.api.getStatus;
    if (!this.registered || typeof refreshStatus !== "function") {
      return;
    }

    const refreshDelays = options.acknowledgementTimedOut
      ? MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS
      : action === "return to dock"
        ? MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS
        : MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS;

    for (const delayMs of refreshDelays) {
      scheduleTimer(() => {
        void refreshStatus
          .call(this.api, this.getDuid(), this.getMatterStatusRefreshOptions())
          .then(() => this.updateMatterStateFromRoborock())
          .catch((error) => {
            this.platform.log.debug(
              `Unable to refresh Matter status after ${action} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
            );
          });
      }, delayMs);
    }
  }

  private getMatterStatusRefreshOptions(): RoborockStatusRefreshOptions {
    const options: RoborockStatusRefreshOptions = { force: true };
    if (this.platform.platformConfig.preferCloudForMatterCommands) {
      options.preferCloud = true;
    }

    return options;
  }

  private getTransportDescription(): string {
    const diagnostics =
      typeof this.api.getTransportDiagnostics === "function"
        ? this.api.getTransportDiagnostics()
        : null;
    const transport =
      diagnostics && typeof diagnostics === "object"
        ? diagnostics[this.getDuid()]
        : null;

    if (!transport || typeof transport !== "object") {
      return "";
    }

    const lastTransport =
      "lastTransport" in transport ? String(transport.lastTransport) : "";
    const lastReason =
      "lastTransportReason" in transport
        ? String(transport.lastTransportReason)
        : "";

    if (lastTransport && lastReason) {
      return `${lastTransport} (${lastReason})`;
    }

    return lastTransport;
  }

  private getErrorMessage(error: unknown): string {
    if (error === undefined || error === null) {
      return "unknown error";
    }

    return error instanceof Error ? error.message : String(error);
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
      this.api.getVacuumDeviceInfo(this.getDuid(), "name") ||
      this.accessory.displayName ||
      "Roborock vacuum"
    );
  }

  private getDuid(): string {
    return String(this.accessory.context.duid);
  }
}
