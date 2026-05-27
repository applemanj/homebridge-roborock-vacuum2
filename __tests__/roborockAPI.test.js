const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

describe("Roborock API model and diagnostics helpers", () => {
  test("prefers device-level model metadata when product metadata is incomplete", async () => {
    const api = new Roborock({ log: createLog() });
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
    const api = new Roborock({ log: createLog() });
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
    const api = new Roborock({ log: createLog() });
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
      { segmentId: 101, roomId: 55, name: "Kitchen" },
      { segmentId: 102, roomId: 99, name: "Room 99" },
    ]);
    expect(notify).toHaveBeenCalledWith(
      "RoomMapping",
      expect.objectContaining({
        duid: "device-1",
        mapId: 2,
      })
    );
  });

  test("transport diagnostics are persisted per device", async () => {
    const api = new Roborock({ log: createLog() });

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

  test("transport diagnostics debug-log cloud fallback and local recovery", async () => {
    const log = createLog();
    const api = new Roborock({ log });
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
    const api = new Roborock({ log });

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
    const api = new Roborock({ log });
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
    const api = new Roborock({
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
    const api = new Roborock({
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
    const api = new Roborock({ log: createLog() });
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
