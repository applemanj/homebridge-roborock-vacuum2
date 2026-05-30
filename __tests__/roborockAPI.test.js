const { Roborock } = require("../roborockLib/roborockAPI");
const fs = require("fs");
const os = require("os");
const path = require("path");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-api-test-")),
    ...options,
  });
}

describe("Roborock API model and diagnostics helpers", () => {
  test("prefers device-level model metadata when product metadata is incomplete", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            productModel: "roborock.vacuum.a08",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getProductAttribute("device-1", "model")).toBe(
      "roborock.vacuum.a08"
    );
  });

  test("getVacuumList merges owned and received devices", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "owned-device" }],
        receivedDevices: [{ duid: "shared-device" }],
      }),
      ack: true,
    });

    expect(api.getVacuumList().map((device) => device.duid)).toEqual([
      "owned-device",
      "shared-device",
    ]);
  });

  test("stores room mapping cache for Matter service areas", () => {
    const api = createRoborock();
    const notify = jest.fn();
    api.roomIDs = { 55: "Kitchen" };
    api.setDeviceNotify(notify);

    api.updateRoomMappingCache("device-1", 2, [
      [101, 55],
      [101, 56],
      ["bad", 57],
      [102, 99],
    ]);

    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 101, roomId: 55, mapId: 2, name: "Kitchen" },
      { segmentId: 102, roomId: 99, mapId: 2, name: "Room 99" },
    ]);
    expect(notify).toHaveBeenCalledWith(
      "RoomMapping",
      expect.objectContaining({
        duid: "device-1",
        mapId: 2,
      })
    );
  });

  test("keeps Matter room mappings for multiple Roborock maps", () => {
    const api = createRoborock();
    api.roomIDs = {
      55: "Kitchen",
      77: "Bedroom",
    };

    api.updateMapListCache("device-1", [
      { mapFlag: 0, name: "Lower Level" },
      { mapFlag: 1, name: "Upper Level" },
    ]);
    api.updateRoomMappingCache("device-1", 0, [[16, 55]]);
    api.updateRoomMappingCache("device-1", 1, [[16, 77]]);

    expect(api.getMapListForDevice("device-1")).toEqual([
      { mapId: 0, name: "Lower Level" },
      { mapId: 1, name: "Upper Level" },
    ]);
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Kitchen" },
      { segmentId: 16, roomId: 77, mapId: 1, name: "Bedroom" },
    ]);
    expect(api.getCurrentMapIdForDevice("device-1")).toBe(1);
  });

  test("Matter Service Area beta caches rooms from missing saved maps while idle", async () => {
    const api = createRoborock({ enableMatterServiceAreaBeta: true });
    api.roomIDs = {
      55: "Lower Level",
      77: "Upper Hallway",
    };
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Floor" },
      { mapFlag: 1, name: "Upper Floor" },
    ];
    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }

        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
          return [[16, 55]];
        }

        return null;
      }),
      command: jest.fn(async (duid, parameter, mapId) => {
        if (parameter !== "load_multi_map") {
          return;
        }

        if (mapId === 1) {
          api.updateRoomMappingCache(duid, 1, [[17, 77]]);
        } else {
          api.updateRoomMappingCache(duid, 0, [[16, 55]]);
        }
      }),
    };

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");

    expect(robot.command).toHaveBeenCalledWith(
      "device-1",
      "load_multi_map",
      1,
      {
        throwOnError: true,
      }
    );
    expect(robot.command).toHaveBeenCalledWith(
      "device-1",
      "load_multi_map",
      0,
      {
        throwOnError: true,
      }
    );
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Lower Level" },
      { segmentId: 17, roomId: 77, mapId: 1, name: "Upper Hallway" },
    ]);
  });

  test("Matter Service Area beta does not reload the active map when its rooms are missing", async () => {
    const api = createRoborock({ enableMatterServiceAreaBeta: true });
    api.roomIDs = {
      55: "Lower Level",
      77: "Upper Hallway",
    };
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [{ id: "product-1", model: "roborock.vacuum.a08" }],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { state: "8" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const mapInfo = [
      { mapFlag: 0, name: "Lower Floor" },
      { mapFlag: 1, name: "Upper Floor" },
    ];
    api.updateMapListCache("device-1", mapInfo);
    api.updateRoomMappingCache("device-1", 0, [[16, 55]]);

    const robot = {
      getParameter: jest.fn(async (duid, parameter) => {
        if (parameter === "get_multi_maps_list") {
          api.updateMapListCache(duid, mapInfo);
          return mapInfo;
        }

        if (parameter === "get_room_mapping") {
          api.updateRoomMappingCache(duid, 1, []);
          return [];
        }

        return null;
      }),
      command: jest.fn(),
    };

    await api.updateDataMinimumData("device-1", robot, "roborock.vacuum.a08");

    expect(robot.command).not.toHaveBeenCalled();
    expect(
      robot.getParameter.mock.calls.filter(
        ([, parameter]) => parameter === "get_room_mapping"
      )
    ).toHaveLength(2);
    expect(api.getRoomMappingsForDevice("device-1")).toEqual([
      { segmentId: 16, roomId: 55, mapId: 0, name: "Lower Level" },
    ]);
  });

  test("detects Matter mop clean mode support from schema capabilities", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
            deviceStatus: { fan_power: "104" },
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getMatterCleanModeCapabilities("device-1")).toEqual({
      canVacuum: true,
      canMop: true,
      canControlFanPower: true,
      canControlWater: true,
    });
    expect(api.getVacuumDeviceStatus("device-1", "fan_power")).toBe("104");
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([
      "set_water_box_mode",
      "set_water_box_custom_mode",
    ]);
  });

  test("does not expose Matter mop clean modes for vacuum-only schemas", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [{ id: 123, code: "fan_power" }],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getMatterCleanModeCapabilities("device-1")).toMatchObject({
      canMop: false,
      canControlFanPower: true,
      canControlWater: false,
    });
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([]);
  });

  test("applies Matter clean mode settings through Roborock setting commands", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [
          {
            duid: "device-1",
            productId: "product-1",
          },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      {
        fanPower: 105,
        waterBoxMode: 201,
      },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_custom_mode",
      105,
      { waitForResult: true, throwOnError: true }
    );
    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_mode",
      201,
      { waitForResult: true, throwOnError: true }
    );
  });

  test("falls back between Roborock water mode commands for Matter clean modes", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.bInited = true;
    api.vacuums["device-1"] = {
      command: jest.fn(async (duid, command) => {
        if (command === "set_water_box_mode") {
          throw new Error("unknown method");
        }
      }),
    };

    await api.applyMatterCleanModeSettings(
      "device-1",
      { waterBoxMode: 201 },
      { waitForResult: true }
    );

    expect(api.vacuums["device-1"].command).toHaveBeenCalledWith(
      "device-1",
      "set_water_box_custom_mode",
      201,
      { waitForResult: true, throwOnError: true }
    );
    expect(api.getMatterWaterModeCommandCandidates("device-1")).toEqual([
      "set_water_box_custom_mode",
    ]);
  });

  test("transport diagnostics are persisted per device", async () => {
    const api = createRoborock();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      tcpConnectionState: "connected",
    });

    expect(api.getTransportDiagnostics()).toEqual({
      "device-1": expect.objectContaining({
        lastTransport: "local",
        tcpConnectionState: "connected",
      }),
    });
  });

  test("caches persisted state in memory after the first disk read", () => {
    const api = createRoborock();
    const persistPath = api.getPersistPath("HomeData");
    const original = {
      val: JSON.stringify({ devices: [{ duid: "device-1" }] }),
      ack: true,
    };
    fs.writeFileSync(persistPath, JSON.stringify(original));

    // The first read loads and parses the persisted file from disk.
    expect(api.getStateAsync("HomeData")).toEqual(original);

    // A later external change to the file is intentionally not observed because
    // the parsed value is now served from the in-memory cache.
    fs.writeFileSync(
      persistPath,
      JSON.stringify({ val: "changed", ack: true })
    );
    expect(api.getStateAsync("HomeData")).toEqual(original);
  });

  test("keeps the in-memory cache in sync with writes and deletes", async () => {
    const api = createRoborock();

    await api.setStateAsync("TransportDiagnostics", { val: "x", ack: true });
    // Served from the cache that setStateAsync populated, without a disk read.
    expect(api.getStateAsync("TransportDiagnostics")).toEqual({
      val: "x",
      ack: true,
    });

    await api.deleteStateAsync("TransportDiagnostics");
    // Deleting persisted state clears the cache entry so the next read reflects
    // the removed file instead of returning a stale cached value.
    expect(api.getStateAsync("TransportDiagnostics")).toBeNull();
  });

  test("transport diagnostics debug-log cloud fallback and local recovery", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "device-1", name: "Hallway Robot" }],
        receivedDevices: [],
      }),
      ack: true,
    });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "cloud",
      lastTransportReason: "local-unavailable-fallback",
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Falling back from local LAN to Roborock cloud")
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "the local TCP socket was not connected when the command was requested"
      )
    );

    log.debug.mockClear();
    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Local transport recovered")
    );
  });

  test("transport diagnostics do not log when only the command method changes", async () => {
    const log = createLog();
    const api = createRoborock({ log });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastCommandMethod: "get_consumable",
    });

    expect(log.debug).not.toHaveBeenCalled();
  });

  test("cloud-only transport reasons are not described as fallback", async () => {
    const log = createLog();
    const api = createRoborock({ log });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [{ duid: "device-1", name: "Hallway Robot" }],
        receivedDevices: [],
      }),
      ack: true,
    });

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "local",
      lastTransportReason: "local-request",
      lastCommandMethod: "get_status",
    });
    log.debug.mockClear();

    await api.updateTransportDiagnostics("device-1", {
      lastTransport: "cloud",
      lastTransportReason: "network-info-cloud-only",
      lastCommandMethod: "get_network_info",
    });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Using Roborock cloud transport")
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("Falling back")
    );
  });

  test("transient command warnings are throttled per robot", async () => {
    const log = createLog();
    let now = 1000;
    const api = createRoborock({
      log,
      errorLogThrottleMs: 60 * 1000,
      now: () => now,
    });

    await api.catchError(
      new Error(
        "Local request with id 149 with method get_consumable timed out after 10 seconds Local connect state: true"
      ),
      "get_consumable",
      "device-1",
      "roborock.vacuum.a51"
    );
    await api.catchError(
      new Error(
        "Local request with id 150 with method get_carpet_mode timed out after 10 seconds Local connect state: true"
      ),
      "get_carpet_mode",
      "device-1",
      "roborock.vacuum.a51"
    );
    await api.catchError(
      new Error(
        "Local request with id 151 with method get_water_box_custom_mode timed out after 10 seconds Local connect state: true"
      ),
      "get_water_box_custom_mode",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Suppressed transient local timeout warning")
    );

    now += 60 * 1000 + 1;
    await api.catchError(
      new Error(
        "Local request with id 152 with method get_status timed out after 10 seconds Local connect state: true"
      ),
      "get_room_mapping",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toContain(
      "2 similar warning(s) across get_carpet_mode (1), get_water_box_custom_mode (1) were suppressed"
    );
    expect(log.warn.mock.calls[1][0]).toContain(
      "Future transient local timeout warnings for this robot"
    );
  });

  test("zero transient warning throttle moves transient warnings to debug only", async () => {
    const log = createLog();
    const api = createRoborock({
      log,
      errorLogThrottleMs: 0,
    });

    await api.catchError(
      new Error(
        "Local request with id 149 with method get_consumable timed out after 10 seconds Local connect state: true"
      ),
      "get_consumable",
      "device-1",
      "roborock.vacuum.a51"
    );

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("Suppressed transient local timeout warning")
    );
  });

  test("skip device helper matches serial numbers and DUIDs", () => {
    const api = createRoborock();
    const ignoredSet = new Set(api.parseSkipDevices("serial-1, duid-2"));

    expect(
      api.shouldSkipDevice({ sn: "serial-1", duid: "duid-1" }, ignoredSet)
    ).toBe(true);
    expect(
      api.shouldSkipDevice({ sn: "serial-2", duid: "duid-2" }, ignoredSet)
    ).toBe(true);
    expect(
      api.shouldSkipDevice({ sn: "serial-3", duid: "duid-3" }, ignoredSet)
    ).toBe(false);
  });
});
