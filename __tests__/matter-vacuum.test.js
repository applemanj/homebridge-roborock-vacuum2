const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { setTimeout: realSetTimeout } = require("node:timers");

const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
const RVC_OPERATIONAL_STATE_STOPPED = 0;
const RVC_OPERATIONAL_STATE_RUNNING = 1;
const RVC_OPERATIONAL_STATE_SEEKING_CHARGER = 64;
const RVC_OPERATIONAL_PHASE_PRIMARY = 0;
const RVC_OPERATIONAL_PHASE_REFRESH = 1;

function flush() {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

afterEach(() => {
  jest.useRealTimers();
});

function createPlatform({
  enableMatter = true,
  enableMatterServiceArea = true,
  enableMatterPowerSource = true,
  enableMatterCleanMode = true,
  enableMatterExtendedOperationalStates = false,
  preferCloudForMatterCommands = false,
  acceptUnscopedLiveMessages = true,
  capabilities = { canVacuum: true, canMop: false },
  rooms = [],
  maps = [],
  currentMapId = null,
  status = {},
  matterUpdates = [],
  appStart = jest.fn().mockResolvedValue(undefined),
  appCharge = jest.fn().mockResolvedValue(undefined),
  appStop = jest.fn().mockResolvedValue(undefined),
  appPause = jest.fn().mockResolvedValue(undefined),
  appSegmentCleanByIds = jest.fn().mockResolvedValue(undefined),
  applyMatterCleanModeSettings = jest.fn().mockResolvedValue(undefined),
  findMe = jest.fn().mockResolvedValue(undefined),
  loadMultiMap = jest.fn().mockResolvedValue(undefined),
  getStatus = jest.fn().mockResolvedValue(undefined),
  updateAccessoryState = jest.fn(async (uuid, cluster, attributes) => {
    matterUpdates.push({ uuid, cluster, attributes });
  }),
} = {}) {
  return {
    platformConfig: {
      enableMatter,
      enableMatterServiceArea,
      enableMatterPowerSource,
      enableMatterCleanMode,
      enableMatterExtendedOperationalStates,
      preferCloudForMatterCommands,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState,
    }),
    shouldAcceptUnscopedLiveMessage: () => acceptUnscopedLiveMessages,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Test Vacuum" : "",
      getProductAttribute: () => "roborock.vacuum.a08",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => rooms.map((room) => ({ ...room })),
      getMapListForDevice: () => maps.map((map) => ({ ...map })),
      getCurrentMapIdForDevice: () =>
        typeof currentMapId === "function" ? currentMapId() : currentMapId,
      getMatterCleanModeCapabilities: () => capabilities,
      app_start: appStart,
      app_stop: appStop,
      app_pause: appPause,
      app_charge: appCharge,
      applyMatterCleanModeSettings,
      find_me: findMe,
      app_segment_clean_by_ids: appSegmentCleanByIds,
      load_multi_map: loadMultiMap,
      getStatus,
    },
  };
}

function createAccessory(platform, isRegistered = false) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    isRegistered
  );
  return { accessory, vacuum };
}

describe("Matter clean mode capabilities", () => {
  test("is exposed by default", () => {
    const platform = createPlatform();
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcCleanMode).toBeDefined();
    expect(accessory.handlers.rvcCleanMode).toBeDefined();
  });

  test("can be disabled independently for controller compatibility", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      matterUpdates,
    });
    const { accessory, vacuum } = createAccessory(platform, true);

    expect(accessory.clusters.rvcCleanMode).toBeUndefined();
    expect(accessory.handlers.rvcCleanMode).toBeUndefined();
    expect(await accessory.getState("rvcCleanMode", "supportedModes")).toBe(
      undefined
    );

    await vacuum.notifyDeviceUpdater("LocalMessage", [{ state: 8 }]);

    expect(
      matterUpdates.some((update) => update.cluster === "rvcCleanMode")
    ).toBe(false);
  });

  test("represents Vacuum + Mop with the two standard RVC clean mode tags", () => {
    const platform = createPlatform({
      capabilities: {
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canControlWater: true,
      },
    });
    const { accessory } = createAccessory(platform);

    const modes = accessory.clusters.rvcCleanMode.supportedModes;
    const vacuumAndMop = modes.find((mode) => mode.label === "Vacuum + Mop");

    expect(vacuumAndMop).toBeDefined();
    expect(vacuumAndMop.modeTags).toEqual([{ value: 16385 }, { value: 16386 }]);
    // No undefined/reserved tag value is advertised.
    const allTagValues = modes.flatMap((mode) =>
      mode.modeTags.map((tag) => tag.value)
    );
    expect(allTagValues).not.toContain(16387);
  });

  test("hides mop modes for vacuum-only models", () => {
    const platform = createPlatform({
      capabilities: { canVacuum: true, canMop: false },
    });
    const { accessory } = createAccessory(platform);

    const labels = accessory.clusters.rvcCleanMode.supportedModes.map(
      (mode) => mode.label
    );
    expect(labels).toEqual(["Vacuum"]);
  });
});

describe("Matter getState", () => {
  test("returns a value for the requested cluster only", async () => {
    const platform = createPlatform({
      capabilities: { canVacuum: true, canMop: true },
    });
    const { accessory } = createAccessory(platform);

    const modes = await accessory.getState("rvcCleanMode", "supportedModes");
    expect(modes.map((mode) => mode.label)).toEqual([
      "Vacuum",
      "Mop",
      "Vacuum + Mop",
    ]);
    expect(
      await accessory.getState("unknownCluster", "anything")
    ).toBeUndefined();
  });
});

describe("Matter startup state updates", () => {
  test("refreshes live state without synthetic identify pulses", async () => {
    const matterUpdates = [];
    const platform = createPlatform({ matterUpdates });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 100 },
    ]);
    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_CLEANING);

    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 8, battery: 100, charge_status: 1 },
    ]);

    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
  });

  test("uses dynamic-only payloads for ordinary Roborock state refreshes", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.updateMatterStateFromRoborock();

    const runModeUpdate = matterUpdates.find(
      (update) => update.cluster === "rvcRunMode"
    );
    const operationalUpdate = matterUpdates.find(
      (update) => update.cluster === "rvcOperationalState"
    );

    expect(runModeUpdate.attributes).toEqual({ currentMode: RUN_MODE_IDLE });
    expect(operationalUpdate.attributes).not.toHaveProperty(
      "operationalStateList"
    );
    expect(operationalUpdate.attributes).not.toHaveProperty("countdownTime");
    expect(operationalUpdate.attributes.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });

  test("refreshes active Roborock snapshots without synthetic identify pulses", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      matterUpdates,
      status: { state: 5, battery: 99, charge_status: 0 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.updateMatterStateFromRoborock();

    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_RUNNING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.currentPhase
    ).toBe(RVC_OPERATIONAL_PHASE_PRIMARY);
  });

  test("skips unchanged Matter state refreshes", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.updateMatterStateFromRoborock();
    expect(matterUpdates.length).toBeGreaterThan(0);

    matterUpdates.length = 0;
    await vacuum.updateMatterStateFromRoborock();

    expect(matterUpdates).toEqual([]);
  });

  test("keeps unchanged docked ready state quiet without a background heartbeat", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.updateMatterStateFromRoborock();
    expect(matterUpdates.length).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(1200);

    matterUpdates.length = 0;
    await vacuum.updateMatterStateFromRoborock();
    expect(matterUpdates).toEqual([]);

    await jest.advanceTimersByTimeAsync(5000);

    expect(matterUpdates).toEqual([]);
  });

  test("publishes cached active state on a lightweight background heartbeat", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 99, charge_status: 0 },
    ]);
    expect(matterUpdates.length).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(1200);

    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 99, charge_status: 0 },
    ]);
    expect(matterUpdates).toEqual([]);

    await jest.advanceTimersByTimeAsync(5000);

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_CLEANING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_RUNNING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.currentPhase
    ).toBe(RVC_OPERATIONAL_PHASE_REFRESH);
    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
  });

  test("refreshes docked ready state without pulsing identify when HomeKit reads the accessory", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { accessory } = createAccessory(platform, true);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);

    await jest.advanceTimersByTimeAsync(0);

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_IDLE);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.currentPhase
    ).toBe(RVC_OPERATIONAL_PHASE_REFRESH);
    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
  });

  test("refreshes active state without identify when HomeKit reads the accessory", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 5, battery: 95, charge_status: 0 },
    });
    const { accessory } = createAccessory(platform, true);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_RUNNING);

    await jest.advanceTimersByTimeAsync(0);

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_CLEANING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_RUNNING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.currentPhase
    ).toBe(RVC_OPERATIONAL_PHASE_REFRESH);
    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );

    matterUpdates.length = 0;
    await accessory.getState("rvcRunMode", "currentMode");
    await jest.advanceTimersByTimeAsync(0);

    expect(matterUpdates).toEqual([]);
  });

  test("uses dynamic-only room mapping refreshes when service area is disabled", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterServiceArea: false,
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("RoomMapping", [
      [16, "668010"],
      [17, "668002"],
    ]);

    const operationalUpdate = matterUpdates.find(
      (update) => update.cluster === "rvcOperationalState"
    );

    expect(operationalUpdate.attributes).not.toHaveProperty(
      "operationalStateList"
    );
  });

  test("retries state refresh when Homebridge endpoint is still initializing", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const updateAccessoryState = jest
      .fn()
      .mockRejectedValueOnce(new Error("uuid-1 is still initializing"))
      .mockImplementation(async (uuid, cluster, attributes) => {
        matterUpdates.push({ uuid, cluster, attributes });
      });
    const platform = createPlatform({ updateAccessoryState });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.updateMatterStateFromRoborock();

    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("endpoint is still initializing")
    );
    expect(matterUpdates.length).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(0);

    expect(updateAccessoryState.mock.calls.length).toBeGreaterThan(3);
  });
});

describe("Matter identify", () => {
  test("routes Locate/Identify to the Roborock find_me command", async () => {
    const matterUpdates = [];
    const findMe = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      findMe,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.identify.identify();

    expect(findMe).toHaveBeenCalledWith("device-1", {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
    expect(
      matterUpdates.filter((update) => update.cluster === "rvcOperationalState")
        .length
    ).toBeGreaterThanOrEqual(1);
    expect(matterUpdates.some((update) => update.cluster === "identify")).toBe(
      false
    );
  });

  test("keeps Identify successful when find_me fails", async () => {
    const findMe = jest.fn().mockRejectedValue(new Error("not supported"));
    const platform = createPlatform({ findMe });
    const { accessory } = createAccessory(platform, true);

    await expect(accessory.handlers.identify.identify()).resolves.toBe(
      undefined
    );
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unable to locate")
    );
  });
});

describe("Matter service area selection", () => {
  test("is exposed by default when Matter is enabled", () => {
    const platform = createPlatform({
      rooms: [{ segmentId: 16, mapId: 0, name: "Kitchen" }],
      maps: [{ mapId: 0, name: "Lower Level" }],
    });
    const { accessory } = createAccessory(platform, true);

    expect(accessory.clusters.serviceArea).toBeDefined();
    expect(accessory.handlers.serviceArea).toBeDefined();
  });

  test("can be disabled independently for controller compatibility", () => {
    const platform = createPlatform({
      enableMatterServiceArea: false,
      rooms: [{ segmentId: 16, mapId: 0, name: "Kitchen" }],
      maps: [{ mapId: 0, name: "Lower Level" }],
    });
    const { accessory } = createAccessory(platform, true);

    expect(accessory.clusters.serviceArea).toBeUndefined();
    expect(accessory.handlers.serviceArea).toBeUndefined();
  });

  test("rejects selections spanning multiple maps with INVALID_SET", async () => {
    const platform = createPlatform({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Kitchen" },
        { segmentId: 17, mapId: 1, name: "Bedroom" },
      ],
      maps: [
        { mapId: 0, name: "Lower Level" },
        { mapId: 1, name: "Upper Level" },
      ],
    });
    const { accessory } = createAccessory(platform, true);

    // areaId = mapId * 1_000_000 + segmentId
    const result = await accessory.handlers.serviceArea.selectAreas({
      newAreas: [16, 1_000_017],
    });

    expect(result.status).toBe(3); // INVALID_SET
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("multiple Roborock maps")
    );
  });

  test("accepts a single-map selection with SUCCESS", async () => {
    const platform = createPlatform({
      rooms: [
        { segmentId: 16, mapId: 0, name: "Kitchen" },
        { segmentId: 18, mapId: 0, name: "Office" },
      ],
      maps: [{ mapId: 0, name: "Lower Level" }],
    });
    const { accessory } = createAccessory(platform, true);

    const result = await accessory.handlers.serviceArea.selectAreas({
      newAreas: [16, 18],
    });

    expect(result.status).toBe(0); // SUCCESS
  });

  test("uses cloud-preferred map switching before selected-area cleaning", async () => {
    const loadMultiMap = jest.fn().mockResolvedValue(undefined);
    const appSegmentCleanByIds = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      currentMapId: 1,
      rooms: [{ segmentId: 16, mapId: 0, name: "Kitchen" }],
      maps: [
        { mapId: 0, name: "Lower Level" },
        { mapId: 1, name: "Upper Level" },
      ],
      appSegmentCleanByIds,
      loadMultiMap,
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.serviceArea.selectAreas({ newAreas: [16] });
    await accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await flush();
    await flush();

    expect(loadMultiMap).toHaveBeenCalledWith("device-1", 0, {
      waitForResult: true,
      preferCloud: true,
      allowOfflineCloudSend: true,
    });
    expect(appSegmentCleanByIds).toHaveBeenCalledWith("device-1", [16], {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
  });

  test("continues selected-area cleaning when the map switch timed out after taking effect", async () => {
    let currentMapId = 1;
    const loadMultiMap = jest.fn().mockImplementation(async () => {
      currentMapId = 0;
      throw new Error(
        "Local request with id 28 with method load_multi_map timed out after 30 seconds"
      );
    });
    const appSegmentCleanByIds = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      currentMapId: () => currentMapId,
      rooms: [{ segmentId: 16, mapId: 0, name: "Kitchen" }],
      maps: [
        { mapId: 0, name: "Lower Level" },
        { mapId: 1, name: "Upper Level" },
      ],
      appSegmentCleanByIds,
      loadMultiMap,
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.serviceArea.selectAreas({ newAreas: [16] });
    await accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await flush();
    await flush();

    expect(appSegmentCleanByIds).toHaveBeenCalledWith("device-1", [16], {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "became active even though the map-load acknowledgement failed"
      )
    );
  });
});

describe("Matter operational state", () => {
  test("advertises operational state IDs without labels (Apple Home compatibility)", () => {
    const platform = createPlatform();
    const { accessory } = createAccessory(platform);

    const list = accessory.clusters.rvcOperationalState.operationalStateList;

    // Apple Home gets stuck on "Connecting" when the list carries labels, so
    // every entry must be a bare { operationalStateId } with no label.
    for (const entry of list) {
      expect(entry).not.toHaveProperty("operationalStateLabel");
      expect(typeof entry.operationalStateId).toBe("number");
    }
  });

  test("uses only basic operational states by default for Apple Home compatibility", () => {
    const platform = createPlatform();
    const { accessory } = createAccessory(platform);

    const list = accessory.clusters.rvcOperationalState.operationalStateList;

    expect(list.map((entry) => entry.operationalStateId)).toEqual([0, 1, 2, 3]);
  });

  test("adds only Returning when extended operational states are enabled", () => {
    const platform = createPlatform({
      enableMatterExtendedOperationalStates: true,
    });
    const { accessory } = createAccessory(platform);

    const list = accessory.clusters.rvcOperationalState.operationalStateList;

    expect(list.map((entry) => entry.operationalStateId)).toEqual([
      0,
      1,
      2,
      3,
      RVC_OPERATIONAL_STATE_SEEKING_CHARGER,
    ]);
  });

  test("includes required phase attributes for Matter compatibility", () => {
    const platform = createPlatform();
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcOperationalState.phaseList).toEqual([
      "State",
      "State",
    ]);
    expect(accessory.clusters.rvcOperationalState.currentPhase).toBe(
      RVC_OPERATIONAL_PHASE_PRIMARY
    );
  });

  test("maps Roborock maintenance states to running for Apple Home compatibility", () => {
    const cases = [
      { state: 22, expected: RVC_OPERATIONAL_STATE_RUNNING }, // emptying dust container
      { state: 23, expected: RVC_OPERATIONAL_STATE_RUNNING }, // washing the mop
      { state: 29, expected: RVC_OPERATIONAL_STATE_RUNNING }, // mapping
    ];

    for (const { state, expected } of cases) {
      const platform = createPlatform({
        enableMatterExtendedOperationalStates: true,
        status: { state },
      });
      const { accessory } = createAccessory(platform);
      expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
        expected
      );
    }
  });

  test("maps returning to stopped when extended states are disabled", () => {
    const platform = createPlatform({ status: { state: 6, battery: 100 } });
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcRunMode.currentMode).toBe(RUN_MODE_IDLE);
    expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });

  test("maps charging to stopped when extended states are disabled", () => {
    const platform = createPlatform({ status: { state: 8, battery: 100 } });
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcRunMode.currentMode).toBe(RUN_MODE_IDLE);
    expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });

  test("keeps Matter run mode active while Roborock is returning to dock when extended states are enabled", () => {
    const platform = createPlatform({
      enableMatterExtendedOperationalStates: true,
      status: { state: 6, battery: 100 },
    });
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcRunMode.currentMode).toBe(RUN_MODE_CLEANING);
    expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
      RVC_OPERATIONAL_STATE_SEEKING_CHARGER
    );
  });

  test("keeps charging stopped when extended returning state is enabled", () => {
    const platform = createPlatform({
      enableMatterExtendedOperationalStates: true,
      status: { state: 8, battery: 100 },
    });
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.rvcRunMode.currentMode).toBe(RUN_MODE_IDLE);
    expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });

  test("forces follow-up status refreshes after returning to dock", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const appCharge = jest.fn().mockResolvedValue(undefined);
    const getStatus = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({ appCharge, getStatus, matterUpdates });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcOperationalState.goHome();
    await jest.advanceTimersByTimeAsync(0);

    expect(appCharge).toHaveBeenCalledWith("device-1", {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_IDLE);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(getStatus).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2000);
    expect(getStatus).toHaveBeenCalledWith("device-1", { force: true });

    await jest.advanceTimersByTimeAsync(13000);
    expect(getStatus).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(165000);
    expect(getStatus).toHaveBeenCalledTimes(8);
  });

  test("does not send a dock command when already docked", async () => {
    const matterUpdates = [];
    const appCharge = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      appCharge,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcOperationalState.goHome();

    expect(appCharge).not.toHaveBeenCalled();
    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_IDLE);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("already docked or charging")
    );
  });

  test("does not publish paused or send pause when already docked", async () => {
    const matterUpdates = [];
    const appPause = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      enableMatterCleanMode: false,
      enableMatterPowerSource: false,
      enableMatterServiceArea: false,
      appPause,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcOperationalState.pause();

    expect(appPause).not.toHaveBeenCalled();
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(
      matterUpdates.some(
        (update) =>
          update.cluster === "rvcOperationalState" &&
          update.attributes.operationalState === 2
      )
    ).toBe(false);
  });

  test("passes cloud preference through Matter commands when enabled", async () => {
    const appStart = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      preferCloudForMatterCommands: true,
      appStart,
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await flush();

    expect(appStart).toHaveBeenCalledWith("device-1", {
      waitForResult: true,
      preferCloud: true,
      allowOfflineCloudSend: true,
    });
  });

  test("does not block Matter start behind slow clean mode prep", async () => {
    jest.useFakeTimers();
    const appStart = jest.fn().mockResolvedValue(undefined);
    const applyMatterCleanModeSettings = jest.fn(
      () => new Promise(() => undefined)
    );
    const platform = createPlatform({
      capabilities: {
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canControlWater: true,
      },
      status: { fan_power: 104, water_box_mode: 202 },
      appStart,
      applyMatterCleanModeSettings,
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcCleanMode.changeToMode({ newMode: 2 });
    await accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await jest.advanceTimersByTimeAsync(2499);

    expect(appStart).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await Promise.resolve();

    expect(appStart).toHaveBeenCalledWith("device-1", {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
    expect(applyMatterCleanModeSettings).toHaveBeenCalledWith(
      "device-1",
      { fanPower: 104, waterBoxMode: 202 },
      {
        waitForResult: true,
        preferLocal: true,
        allowOfflineCloudSend: true,
        requestTimeoutMs: 2000,
      }
    );
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("continuing with the start command")
    );
  });

  test("passes cloud preference through Matter follow-up status refreshes when enabled", async () => {
    jest.useFakeTimers();
    const appCharge = jest.fn().mockResolvedValue(undefined);
    const getStatus = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      preferCloudForMatterCommands: true,
      appCharge,
      getStatus,
    });
    const { accessory } = createAccessory(platform, true);

    await accessory.handlers.rvcOperationalState.goHome();
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(2000);
    expect(getStatus).toHaveBeenCalledWith("device-1", {
      force: true,
      preferCloud: true,
    });
  });
});

describe("Matter power source", () => {
  test("is exposed by default", () => {
    const platform = createPlatform({ status: { state: 8, battery: 100 } });
    const { accessory } = createAccessory(platform);

    expect(accessory.clusters.powerSource).toBeDefined();
  });

  test("can be disabled independently for controller compatibility", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterPowerSource: false,
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { accessory, vacuum } = createAccessory(platform, true);

    expect(accessory.clusters.powerSource).toBeUndefined();
    expect(await accessory.getState("powerSource", "batPercentRemaining")).toBe(
      undefined
    );

    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 8, battery: 100 },
    ]);

    expect(
      matterUpdates.some((update) => update.cluster === "powerSource")
    ).toBe(false);
  });
});

describe("Matter live status cache", () => {
  test("prefers the freshest live message value over the HomeData snapshot", async () => {
    // HomeData reports the vacuum docked/charging (state 8 -> STOPPED in the
    // Apple-safe default mode).
    const platform = createPlatform({ status: { state: 8, battery: 50 } });
    const { accessory, vacuum } = createAccessory(platform, true);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);

    // A live message says it is now cleaning (state 5 -> RUNNING).
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 50 },
    ]);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(1); // RUNNING, sourced from the live cache rather than HomeData
  });

  test("ignores unscoped live arrays when multiple vacuums are configured", async () => {
    const platform = createPlatform({
      acceptUnscopedLiveMessages: false,
      status: { state: 8, battery: 50 },
    });
    const { accessory, vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("CloudMessage", [
      { state: 5, battery: 50 },
    ]);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring unscoped live Roborock update")
    );
  });

  test("ignores device-scoped live messages for other vacuums", async () => {
    const platform = createPlatform({ status: { state: 8, battery: 50 } });
    const { accessory, vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "other-device",
      payload: [{ state: 5, battery: 50 }],
    });

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);

    await vacuum.notifyDeviceUpdater("CloudMessage", {
      duid: "device-1",
      payload: [{ state: 5, battery: 50 }],
    });

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(1); // RUNNING
  });

  test("lets a newer HomeData docked snapshot replace a stale live cleaning state", async () => {
    const matterUpdates = [];
    const platform = createPlatform({
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { accessory, vacuum } = createAccessory(platform, true);

    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 100 },
    ]);
    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_RUNNING);

    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("HomeData", {
      val: JSON.stringify({
        devices: [
          {
            duid: "device-1",
            deviceStatus: { state: "8", battery: "100" },
          },
        ],
      }),
    });

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_IDLE);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
  });
});

describe("Matter optimistic state", () => {
  test("abandons an optimistic state after repeated contradicting live updates", async () => {
    const matterUpdates = [];
    const platform = createPlatform({ matterUpdates });
    const { vacuum } = createAccessory(platform, true);

    // Optimistically mark the vacuum as cleaning via the Matter run-mode handler.
    await vacuum.accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await flush();

    const chargingMessage = [{ state: 8, battery: 100, charge_status: 1 }];

    // First contradicting update is tolerated: operational state stays optimistic.
    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", chargingMessage);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
    ).toBeUndefined();

    // Second contradicting update is trusted: the real stopped/docked state is pushed.
    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", chargingMessage);
    const operationalUpdate = matterUpdates.find(
      (update) => update.cluster === "rvcOperationalState"
    );
    expect(operationalUpdate).toBeDefined();
    expect(operationalUpdate.attributes.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
  });

  test("keeps optimistic state when a Matter command acknowledgement times out", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const getStatus = jest.fn().mockResolvedValue(undefined);
    const appStart = jest
      .fn()
      .mockRejectedValue(
        new Error(
          "Cloud request with id 1748 with method app_start timed out after 10 seconds. MQTT connection state: true"
        )
      );
    const platform = createPlatform({
      appStart,
      getStatus,
      matterUpdates,
      status: { state: 8, battery: 100 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    const operationalUpdates = matterUpdates.filter(
      (update) =>
        update.cluster === "rvcOperationalState" &&
        typeof update.attributes.operationalState === "number"
    );
    expect(operationalUpdates).toHaveLength(1);
    expect(operationalUpdates[0].attributes.operationalState).toBe(1);
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("actively refreshing Roborock status")
    );
    expect(getStatus).toHaveBeenCalledWith("device-1", { force: true });

    await jest.advanceTimersByTimeAsync(2000);
    expect(getStatus).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(3000);
    expect(getStatus).toHaveBeenCalledTimes(3);

    jest.clearAllTimers();
  });

  test("sends dock after a timed-out start while the cached state still says docked", async () => {
    jest.useFakeTimers();
    const appStart = jest
      .fn()
      .mockRejectedValue(
        new Error(
          "Cloud request with id 1748 with method app_start timed out after 10 seconds. MQTT connection state: true"
        )
      );
    const appCharge = jest.fn().mockResolvedValue(undefined);
    const platform = createPlatform({
      appStart,
      appCharge,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await Promise.resolve();
    await Promise.resolve();

    await vacuum.accessory.handlers.rvcOperationalState.goHome();

    expect(appCharge).toHaveBeenCalledWith("device-1", {
      waitForResult: true,
      preferLocal: true,
      allowOfflineCloudSend: true,
    });
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("despite a stale docked snapshot")
    );

    jest.clearAllTimers();
  });

  test("does not let a stale optimistic update override hard command failure recovery", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const appStart = jest
      .fn()
      .mockRejectedValue(new Error("Device device-1 is offline."));
    const platform = createPlatform({
      appStart,
      matterUpdates,
      status: { state: 8, battery: 100, charge_status: 1 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.accessory.handlers.rvcRunMode.changeToMode({
      newMode: RUN_MODE_CLEANING,
    });
    await Promise.resolve();
    await Promise.resolve();

    const recoveredOperationalUpdates = matterUpdates.filter(
      (update) => update.cluster === "rvcOperationalState"
    );
    expect(recoveredOperationalUpdates.at(-1).attributes.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );

    await jest.advanceTimersByTimeAsync(0);

    const finalOperationalUpdates = matterUpdates.filter(
      (update) => update.cluster === "rvcOperationalState"
    );
    expect(finalOperationalUpdates.at(-1).attributes.operationalState).toBe(
      RVC_OPERATIONAL_STATE_STOPPED
    );
    expect(platform.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Skipping stale Matter optimistic state update")
    );
  });

  test("keeps return-to-dock active until Roborock reports docked", async () => {
    jest.useFakeTimers();
    const matterUpdates = [];
    const platform = createPlatform({
      enableMatterExtendedOperationalStates: true,
      matterUpdates,
      status: { state: 5, battery: 100 },
    });
    const { vacuum } = createAccessory(platform, true);

    await vacuum.accessory.handlers.rvcOperationalState.goHome();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_CLEANING);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_SEEKING_CHARGER);

    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 6, battery: 100, charge_status: 0 },
    ]);

    expect(
      await vacuum.accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_SEEKING_CHARGER);

    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 8, battery: 100, charge_status: 1 },
    ]);

    expect(
      matterUpdates.find((update) => update.cluster === "rvcRunMode").attributes
        .currentMode
    ).toBe(RUN_MODE_IDLE);
    expect(
      matterUpdates.find((update) => update.cluster === "rvcOperationalState")
        .attributes.operationalState
    ).toBe(RVC_OPERATIONAL_STATE_STOPPED);
    jest.clearAllTimers();
  });
});
