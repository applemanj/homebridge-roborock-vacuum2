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
const SLOW_MATTER_COMMAND_MS = 3000;

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
  private selectedServiceAreaIds: number[] = [];
  private lastServiceAreaSummary = "";

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
    if (id === "HomeData" || id === "RoomMapping") {
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
    const handlers: Record<string, Record<string, unknown>> = {
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

    if (this.isServiceAreaBetaEnabled()) {
      handlers.serviceArea = {
        selectAreas: async (request?: { newAreas?: unknown }) => {
          return await this.selectServiceAreas(request?.newAreas);
        },
      };
    }

    return handlers;
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
        if (selectedMapIds.length > 1) {
          throw new Error(
            `Matter can only start room cleaning on one Roborock map at a time for ${name}.`
          );
        }

        const selectedAreaNames = selectedAreas.map((area) =>
          this.formatServiceAreaName(area)
        );
        const targetMapId = selectedMapIds[0] ?? null;
        this.platform.log.info(
          `Starting ${name} from Matter for selected service area(s): ${selectedAreaNames.join(", ")}.`
        );
        const state = {
          rvcRunMode: { currentMode: RUN_MODE_CLEANING },
          rvcOperationalState: {
            operationalState: RVC_OPERATIONAL_STATE.RUNNING,
          },
        };
        this.setOptimisticState(state);
        this.scheduleMatterStateUpdate(state, "selected-area start");
        this.dispatchRoborockMatterCommand("service area clean", async () => {
          await this.loadMatterMapIfNeeded(duid, targetMapId);
          await this.platform.roborockAPI.app_segment_clean_by_ids(
            duid,
            selectedAreas.map((area) => area.segmentId),
            { waitForResult: true }
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
      this.setOptimisticState(state);
      this.scheduleMatterStateUpdate(state, "start");
      this.dispatchRoborockMatterCommand("start", () =>
        this.platform.roborockAPI.app_start(duid, { waitForResult: true })
      );
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
      this.setOptimisticState(state);
      this.scheduleMatterStateUpdate(state, "stop");
      this.dispatchRoborockMatterCommand("stop", () =>
        this.platform.roborockAPI.app_stop(duid, { waitForResult: true })
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

    if (newMode === CLEAN_MODE_VACUUM) {
      const state = {
        rvcCleanMode: { currentMode: CLEAN_MODE_VACUUM },
      };
      this.setOptimisticState(state);
      this.scheduleMatterStateUpdate(state, "clean mode change");
      return;
    }

    this.platform.log.warn(
      `Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`
    );
  }

  private async pauseCleaning(): Promise<void> {
    this.platform.log.info(`Pausing ${this.getVacuumName()} from Matter.`);
    const state = {
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.PAUSED,
      },
    };
    this.setOptimisticState(state);
    this.scheduleMatterStateUpdate(state, "pause");
    this.dispatchRoborockMatterCommand("pause", () =>
      this.platform.roborockAPI.app_pause(this.getDuid(), {
        waitForResult: true,
      })
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
    this.setOptimisticState(state);
    this.scheduleMatterStateUpdate(state, "resume");
    this.dispatchRoborockMatterCommand("resume", () =>
      this.platform.roborockAPI.app_start(this.getDuid(), {
        waitForResult: true,
      })
    );
  }

  private async returnToDock(): Promise<void> {
    this.platform.log.info(
      `Sending ${this.getVacuumName()} back to dock from Matter.`
    );
    const state = {
      rvcRunMode: { currentMode: RUN_MODE_IDLE },
      rvcOperationalState: {
        operationalState: RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
      },
    };
    this.setOptimisticState(state);
    this.scheduleMatterStateUpdate(state, "return to dock");
    this.dispatchRoborockMatterCommand("return to dock", () =>
      this.platform.roborockAPI.app_charge(this.getDuid(), {
        waitForResult: true,
      })
    );
  }

  private scheduleMatterStateUpdate(
    partialClusters: MatterClusterState,
    reason: string
  ): void {
    if (!this.registered) {
      return;
    }

    setTimeout(() => {
      void this.updateMatterState(partialClusters).catch((error) => {
        this.platform.log.warn(
          `Unable to update Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
      });
    }, 0);
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
      clusters.powerSource = this.buildPowerSourceCluster(
        battery,
        chargeStatus,
        state
      );
    }

    if (Object.keys(clusters).length > 0) {
      await this.updateMatterState(clusters);
    }
  }

  private buildClusters(): MatterClusterState {
    const clusters: MatterClusterState = {
      rvcRunMode: this.buildRunModeCluster(),
      rvcCleanMode: this.buildCleanModeCluster(),
      rvcOperationalState: this.buildOperationalStateCluster(),
      powerSource: this.buildPowerSourceCluster(),
    };

    if (this.isServiceAreaBetaEnabled()) {
      clusters.serviceArea = this.buildServiceAreaCluster();
    }

    return this.applyOptimisticState(clusters);
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

  private buildServiceAreaCluster(): Record<string, unknown> {
    const areas = this.getMatterServiceAreas();
    const supportedMaps = this.getMatterServiceAreaMaps(areas);
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
            locationName: area.name,
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
      throw new Error(
        `Select service areas from only one Roborock map at a time for ${this.getVacuumName()}.`
      );
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
    const getRoomMappingsForDevice =
      this.platform.roborockAPI.getRoomMappingsForDevice;
    if (typeof getRoomMappingsForDevice !== "function") {
      return [];
    }

    const rooms = getRoomMappingsForDevice.call(
      this.platform.roborockAPI,
      this.getDuid()
    );
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
    const maps: MatterServiceAreaMap[] = [];
    const seenMapIds = new Set<number>();
    const knownMapsById = new Map(
      this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map])
    );

    for (const area of areas) {
      if (area.mapId === null || seenMapIds.has(area.mapId)) {
        continue;
      }

      seenMapIds.add(area.mapId);
      maps.push({
        mapId: area.mapId,
        name:
          area.mapName ||
          knownMapsById.get(area.mapId)?.name ||
          `Roborock Map ${area.mapId}`,
      });
    }

    return maps;
  }

  private getMatterServiceAreaMapsFromRoborock(): MatterServiceAreaMap[] {
    const getMapListForDevice = this.platform.roborockAPI.getMapListForDevice;
    if (typeof getMapListForDevice !== "function") {
      return [];
    }

    const maps = getMapListForDevice.call(
      this.platform.roborockAPI,
      this.getDuid()
    );
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
        `Matter Service Area beta is enabled for ${this.getVacuumName()}, but no Roborock rooms are available to expose yet.`
      );
      return;
    }

    this.platform.log.info(
      `Matter Service Area beta for ${this.getVacuumName()}: exposing ${areas.length} room(s)` +
        `${maps.length > 0 ? ` on ${maps.length} map(s)` : ""}: ${areas.map((area) => area.name).join(", ")}.`
    );
  }

  private getSelectedServiceAreaSegments(): MatterServiceArea[] {
    if (!this.isServiceAreaBetaEnabled()) {
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

  private toMatterLocationName(name: unknown, areaId: number): string {
    const fallbackName = `Room ${areaId}`;
    const normalizedName =
      typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    const locationName = normalizedName || fallbackName;

    return locationName.length > MATTER_LOCATION_NAME_MAX_LENGTH
      ? locationName.slice(0, MATTER_LOCATION_NAME_MAX_LENGTH).trim() ||
          fallbackName
      : locationName;
  }

  private toMatterMapName(name: unknown, mapId: number): string {
    const fallbackName = `Roborock Map ${mapId}`;
    const normalizedName =
      typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    const mapName = normalizedName || fallbackName;

    return mapName.length > MATTER_MAP_NAME_MAX_LENGTH
      ? mapName.slice(0, MATTER_MAP_NAME_MAX_LENGTH).trim() || fallbackName
      : mapName;
  }

  private formatServiceAreaName(area: MatterServiceArea): string {
    return area.mapName ? `${area.name} (${area.mapName})` : area.name;
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

    const loadMap = this.platform.roborockAPI.load_multi_map;
    if (typeof loadMap !== "function") {
      throw new Error(
        `Roborock map ${targetMapId} is not currently loaded and this plugin cannot switch maps.`
      );
    }

    this.platform.log.info(
      `Loading Roborock map ${targetMapId} for ${this.getVacuumName()} before selected-area cleaning.`
    );
    await loadMap.call(this.platform.roborockAPI, duid, targetMapId, {
      waitForResult: true,
    });
  }

  private getCurrentMatterMapId(): number | null {
    const getCurrentMapIdForDevice =
      this.platform.roborockAPI.getCurrentMapIdForDevice;
    if (typeof getCurrentMapIdForDevice !== "function") {
      return null;
    }

    const currentMapId = getCurrentMapIdForDevice.call(
      this.platform.roborockAPI,
      this.getDuid()
    );

    return this.getMatterMapId(currentMapId);
  }

  private isServiceAreaBetaEnabled(): boolean {
    return Boolean(
      this.platform.platformConfig.enableMatter &&
        this.platform.platformConfig.enableMatterServiceAreaBeta
    );
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

  private dispatchRoborockMatterCommand(
    action: string,
    command: () => Promise<void>
  ): void {
    const startedAt = Date.now();

    void command()
      .then(() => {
        this.logMatterCommandDuration(action, startedAt);
      })
      .catch((error) => {
        this.platform.log.error(
          `Error sending Matter ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`
        );
        this.clearOptimisticState();
        void this.updateMatterStateFromRoborock();
      });
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

  private getTransportDescription(): string {
    const diagnostics =
      typeof this.platform.roborockAPI.getTransportDiagnostics === "function"
        ? this.platform.roborockAPI.getTransportDiagnostics()
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
      this.platform.roborockAPI.getVacuumDeviceInfo(this.getDuid(), "name") ||
      this.accessory.displayName ||
      "Roborock vacuum"
    );
  }

  private getDuid(): string {
    return String(this.accessory.context.duid);
  }
}
