// A Q10 gets Q10 frames.
//
// `pv === "B01"` is two wire dialects, not one, and this plugin published the
// wrong one to `ss*` models.
//
//   Q7:  {"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}
//   Q10: {"dps":{"201":1}}
//
// Datapoint 10000 does not exist on a Q10, so a Q7 frame is correctly framed,
// correctly encrypted, addressed to a datapoint the robot does not have, and
// discarded without comment. Issue #10 is the result: the reporter's HomeKit
// write reaches the plugin, `app_start` is genuinely sent, and the command then
// sits until its 10 second timeout expires on a healthy link.
//
// Two properties of the dialect drive every test below.
//
// 1. IT ANSWERS NOTHING. Q10 commands are fire-and-forget; the protocol defines
//    no RPC reply. So a Q10 request must NOT register a pending request and must
//    NOT arm a timeout — a timeout on a dialect that never replies is guaranteed
//    to fire, which is exactly the false "the cloud went silent" report.
//
// 2. THEREFORE READS CANNOT BE SERVED. `get_status`, `get_prop` and
//    `get_room_mapping` are refused rather than translated. Translating a read
//    would resolve the caller with a value the robot never sent, and
//    `mapStatusToV1` would then publish that non-answer to Apple Home as the
//    robot's state. Status on a Q10 keeps arriving from home data over HTTPS,
//    a separate transport that works.
//
// Every datapoint code asserted here came from upstream python-roborock
// (`b01_q10_code_mappings.py`, `q10/vacuum.py`), whose docstrings mark them
// verified live against ss07 hardware. NOTHING here was verified against a Q10
// by this project — there is no Q10 on hand. That is why the Q7 regression
// block at the bottom exists.

const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const b01Q10Adapter = require("../roborockLib/lib/b01Q10Adapter");
const { b01FamilyForModel, B01_FAMILY } = require("../roborockLib/lib/b01Family");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// Records what buildPayload was asked to build, so the wire shape can be
// asserted without reimplementing the encoder in the test.
function createB01Adapter(model, overrides = {}) {
  const buildPayload = jest.fn(
    async (duid, protocol, messageID, method, params, secure, photo, options) =>
      JSON.stringify(
        options && options.b01Q10Dps
          ? { dps: options.b01Q10Dps }
          : {
              dps: {
                10000: {
                  method,
                  msgId: String(messageID),
                  params: params ?? [],
                },
              },
            }
      )
  );

  return {
    isRemoteDevice: jest.fn().mockResolvedValue(true),
    getRobotVersion: jest.fn().mockResolvedValue("B01"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    getProductAttribute: jest.fn(() => model),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn(),
    },
    config: {},
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload,
      buildRoborockMessage: jest.fn().mockResolvedValue(Buffer.from("message")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn((callback) => setTimeout(callback, 0)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: createLog(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    ...overrides,
  };
}

/** The dps object the adapter was asked to publish, parsed off buildPayload. */
function publishedDps(adapter) {
  const call = adapter.message.buildPayload.mock.calls.at(-1);
  return call?.[7]?.b01Q10Dps ?? null;
}

// The command surface, with the exact upstream payload for each. Table-driven
// so a mapping added to the adapter without a verified payload fails here
// rather than in a stranger's robot.
const Q10_COMMANDS = [
  ["app_start", [], { 201: 1 }],
  ["app_stop", [], { 206: 0 }],
  ["app_pause", [], { 204: 0 }],
  ["app_charge", [], { 202: 5 }],
  ["app_start_collect_dust", [], { 203: 2 }],
  [
    "app_segment_clean_by_ids",
    { segments: [9, 11] },
    { 201: { cmd: 2, clean_paramters: [9, 11] } },
  ],
  ["set_custom_mode", [104], { 123: 4 }],
  ["set_clean_type", [1], { 137: 3 }],
];

// Reads. The dialect never answers, so these must stay refused.
const Q10_UNANSWERABLE = [
  "get_status",
  "get_prop",
  "get_room_mapping",
  "get_multi_maps_list",
];

describe("a Q10 gets Q10 frames", () => {
  test.each(Q10_COMMANDS)(
    "%s publishes its Q10 datapoint write",
    async (method, params, expectedDps) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await expect(
        handler.sendRequest("duid-q10", method, params)
      ).resolves.toEqual(["ok"]);

      expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
      expect(publishedDps(adapter)).toEqual(expectedDps);
    }
  );

  test("a segment clean from this plugin's own call shape still finds its rooms", async () => {
    // vacuum.js builds `roomList = {segments, repeat}` and sends `[roomList]`,
    // so the rooms are one level deeper than a bare array. Flattening that to
    // `[NaN]` and filtering it away would silently refuse every room clean.
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_segment_clean", [
      { segments: [16, 17], repeat: 1 },
    ]);

    expect(publishedDps(adapter)).toEqual({
      201: { cmd: 2, clean_paramters: [16, 17] },
    });
  });

  test("no Q10 frame carries a method, a msgId or datapoint 10000", async () => {
    for (const [method, params] of Q10_COMMANDS) {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await handler.sendRequest("duid-q10", method, params);

      const dps = publishedDps(adapter);
      expect(Object.keys(dps)).toHaveLength(1);
      expect(dps).not.toHaveProperty("10000");
      expect(JSON.stringify(dps)).not.toMatch(/"(method|msgId)"/);
    }
  });

  test("a command resolves on publish, with no pending request and no timeout", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_start", []);

    // A timeout on a dialect that never replies always fires. Arming one is how
    // a working command becomes a reported cloud fault.
    expect(adapter.setTimeout).not.toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  test("the log says the command was published, not acknowledged", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_start", []);

    const said = adapter.log.debug.mock.calls.flat().join(" ");
    expect(said).toMatch(/fire-and-forget/i);
  });

  test("a Q10 write over local transport also resolves on publish", async () => {
    // This plugin does not force B01 onto the cloud the way the sibling does,
    // so the fire-and-forget branch has to work on both transports.
    const adapter = createB01Adapter("roborock.vacuum.ss07", {
      isRemoteDevice: jest.fn().mockResolvedValue(false),
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q10", "app_start", [])
    ).resolves.toEqual(["ok"]);

    expect(adapter.localConnector.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
    expect(adapter.setTimeout).not.toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "duid-q10",
      expect.objectContaining({
        lastTransport: "local",
        lastTransportReason: "b01-q10-fire-and-forget",
        lastCommandMethod: "app_start",
      })
    );
  });

  test("a cloud write records the fire-and-forget reason", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await handler.sendRequest("duid-q10", "app_start", []);

    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "duid-q10",
      expect.objectContaining({
        lastTransport: "cloud",
        lastTransportReason: "b01-q10-fire-and-forget",
        lastCommandMethod: "app_start",
      })
    );
  });

  test.each(Q10_UNANSWERABLE)(
    "%s is still refused on a Q10, because the dialect answers nothing",
    async (method) => {
      const adapter = createB01Adapter("roborock.vacuum.ss07");
      const handler = new messageQueueHandler(adapter);

      await expect(handler.sendRequest("duid-q10", method, [])).rejects.toThrow(
        /Q10/
      );

      expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
      expect(adapter.localConnector.sendMessage).not.toHaveBeenCalled();
    }
  );

  test("a refusal is a capability fact, so it is calm rather than a fake timeout", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    const error = await handler
      .sendRequest("duid-q10", "get_status", [])
      .catch((caught) => caught);

    expect(error.code).toBe("B01_METHOD_UNSUPPORTED");
    expect(error.message).not.toMatch(/timed out/);
    expect(error.message).not.toMatch(/MQTT connection state/);
  });

  test("a method with no Q10 equivalent is refused rather than guessed", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    // Zoned and go-to-target cleans have no verified Q10 datapoint. Inventing
    // one on a robot nobody here owns is not a risk worth taking.
    await expect(
      handler.sendRequest("duid-q10", "app_zoned_clean", [[1, 1, 2, 2, 1]])
    ).rejects.toThrow(/Q10/);

    await expect(
      handler.sendRequest("duid-q10", "app_goto_target", [1, 2])
    ).rejects.toThrow(/Q10/);

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  test("a segment clean with no rooms is refused rather than sent empty", async () => {
    const adapter = createB01Adapter("roborock.vacuum.ss07");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q10", "app_segment_clean_by_ids", {
        segments: [],
      })
    ).rejects.toThrow(/Q10/);

    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });

  test("an unknown model is left on the Q7 path rather than half-migrated", () => {
    // Q7 is what every B01 device was before this existed, so an unrecognised
    // model cannot be made worse than it already was.
    expect(b01FamilyForModel(null)).toBe(B01_FAMILY.Q7);
    expect(b01FamilyForModel(undefined)).toBe(B01_FAMILY.Q7);
    expect(b01FamilyForModel("")).toBe(B01_FAMILY.Q7);
    expect(b01FamilyForModel("roborock.vacuum.a51")).toBe(B01_FAMILY.Q7);
    expect(b01FamilyForModel("roborock.vacuum.sc05")).toBe(B01_FAMILY.Q7);
    expect(b01FamilyForModel("roborock.vacuum.ss07")).toBe(B01_FAMILY.Q10);
    expect(b01FamilyForModel("ROBOROCK.VACUUM.SS07")).toBe(B01_FAMILY.Q10);
  });

  describe("the two families' tables are not interchangeable", () => {
    // Both families' clean-type numbers overlap, so a substituted table does
    // not throw — it mops when it was asked to vacuum, or the reverse.
    test("Matter vacuum is 0 on a Q7 and 2 on a Q10", () => {
      expect(b01Q10Adapter.MATTER_TO_Q10_CLEAN_TYPE[0]).toBe(2);
      expect(b01Q10Adapter.translateOutgoing("set_clean_type", [0])).toEqual({
        dp: 137,
        params: 2,
      });
    });

    test("the Q10 clean-type mapping round-trips", () => {
      for (const matter of [0, 1, 2]) {
        const q10 = b01Q10Adapter.MATTER_TO_Q10_CLEAN_TYPE[matter];
        expect(b01Q10Adapter.Q10_CLEAN_TYPE_TO_MATTER[q10]).toBe(matter);
      }
    });

    test("max+ suction is 8 on a Q10, not the Q7's 5", () => {
      expect(b01Q10Adapter.translateOutgoing("set_custom_mode", [108])).toEqual({
        dp: 123,
        params: 8,
      });
    });

    test("off is a real suction level on a Q10 and is not degraded to quiet", () => {
      expect(b01Q10Adapter.Q10_V1_FAN_POWER_TO_WIND[105]).toBe(0);
    });
  });

  test("a falsy datapoint value survives encoding", () => {
    // pause/resume/stop all send 0. Collapsing it to {} the way a naive
    // `params || {}` would is a silent no-op on the robot.
    expect(b01Q10Adapter.buildDps(204, 0)).toEqual({ 204: 0 });
    expect(b01Q10Adapter.buildDps(204, null)).toEqual({ 204: {} });
  });

  // ---- Regression cover. Q7 works today, and no Q10 change may touch it. ----

  test("a Q7 still publishes the RPC envelope on datapoint 10000", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc05");
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-q7", "app_start", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
    // No Q10 options bag reached the encoder, so the Q7 branch built the frame.
    expect(publishedDps(adapter)).toBeNull();
  });

  test("a Q7 still arms a timeout and registers a pending request", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc01");
    const handler = new messageQueueHandler(adapter);

    // Awaited before asserting: the timeout is armed several awaits deep, and
    // an un-awaited rejection here leaks into whichever test runs next.
    await expect(
      handler.sendRequest("duid-q7", "get_status", [])
    ).rejects.toThrow(/timed out/);

    expect(adapter.setTimeout).toHaveBeenCalled();
    expect(adapter.pendingRequests.size).toBe(0);
  });

  test("a Q7 still passes its own method name through untranslated", async () => {
    const adapter = createB01Adapter("roborock.vacuum.sc05");
    const handler = new messageQueueHandler(adapter);

    await handler
      .sendRequest("duid-q7", "app_start", [])
      .catch(() => undefined);

    const [, , , method] = adapter.message.buildPayload.mock.calls.at(-1);
    expect(method).toBe("app_start");
  });

  test("a non-B01 robot is untouched by all of this", async () => {
    const adapter = createB01Adapter("roborock.vacuum.a51", {
      getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    });
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("duid-l01", "get_status", [])
    ).rejects.toThrow(/timed out/);

    expect(publishedDps(adapter)).toBeNull();
    expect(adapter.setTimeout).toHaveBeenCalled();
  });
});