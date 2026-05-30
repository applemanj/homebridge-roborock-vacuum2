const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const RUN_MODE_CLEANING = 1;
const RVC_OPERATIONAL_STATE_CHARGING = 65;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createPlatform({
  serviceAreaBeta = false,
  capabilities = { canVacuum: true, canMop: false },
  rooms = [],
  maps = [],
  status = {},
  matterUpdates = [],
  appStart = jest.fn().mockResolvedValue(undefined),
} = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterServiceAreaBeta: serviceAreaBeta,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn(async (uuid, cluster, attributes) => {
        matterUpdates.push({ uuid, cluster, attributes });
      }),
    }),
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Test Vacuum" : "",
      getProductAttribute: () => "roborock.vacuum.a08",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => rooms.map((room) => ({ ...room })),
      getMapListForDevice: () => maps.map((map) => ({ ...map })),
      getMatterCleanModeCapabilities: () => capabilities,
      app_start: appStart,
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

describe("Matter service area selection", () => {
  test("rejects selections spanning multiple maps with INVALID_SET", async () => {
    const platform = createPlatform({
      serviceAreaBeta: true,
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
      serviceAreaBeta: true,
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

  test("maps Roborock dock/maintenance states to their operational state IDs", () => {
    const cases = [
      { state: 22, expected: 67 }, // emptying dust container
      { state: 23, expected: 68 }, // washing the mop
      { state: 29, expected: 70 }, // mapping
    ];

    for (const { state, expected } of cases) {
      const platform = createPlatform({ status: { state } });
      const { accessory } = createAccessory(platform);
      expect(accessory.clusters.rvcOperationalState.operationalState).toBe(
        expected
      );
    }
  });
});

describe("Matter live status cache", () => {
  test("prefers the freshest live message value over the HomeData snapshot", async () => {
    // HomeData reports the vacuum docked/charging (state 8 -> CHARGING).
    const platform = createPlatform({ status: { state: 8, battery: 50 } });
    const { accessory, vacuum } = createAccessory(platform, true);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(RVC_OPERATIONAL_STATE_CHARGING);

    // A live message says it is now cleaning (state 5 -> RUNNING).
    await vacuum.notifyDeviceUpdater("LocalMessage", [
      { state: 5, battery: 50 },
    ]);

    expect(
      await accessory.getState("rvcOperationalState", "operationalState")
    ).toBe(1); // RUNNING, sourced from the live cache rather than HomeData
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

    // Second contradicting update is trusted: the real charging state is pushed.
    matterUpdates.length = 0;
    await vacuum.notifyDeviceUpdater("LocalMessage", chargingMessage);
    const operationalUpdate = matterUpdates.find(
      (update) => update.cluster === "rvcOperationalState"
    );
    expect(operationalUpdate).toBeDefined();
    expect(operationalUpdate.attributes.operationalState).toBe(
      RVC_OPERATIONAL_STATE_CHARGING
    );
  });
});
