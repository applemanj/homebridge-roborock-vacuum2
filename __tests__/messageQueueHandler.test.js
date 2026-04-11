const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");

function createAdapter(overrides = {}) {
  const adapter = {
    isRemoteDevice: jest.fn().mockResolvedValue(false),
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    rr_mqtt_connector: {
      isConnected: jest.fn().mockReturnValue(true),
      sendMessage: jest.fn(),
    },
    localConnector: {
      isConnected: jest.fn().mockReturnValue(false),
      sendMessage: jest.fn(),
      clearChunkBuffer: jest.fn(),
    },
    message: {
      buildPayload: jest.fn().mockResolvedValue("payload"),
      buildRoborockMessage: jest
        .fn()
        .mockResolvedValue(Buffer.from("message")),
    },
    getRequestId: jest.fn().mockReturnValue(42),
    pendingRequests: new Map(),
    setTimeout: jest.fn((callback) => setTimeout(callback, 5000)),
    clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
    log: {
      info: jest.fn(),
      debug: jest.fn(),
    },
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    ...overrides,
  };

  return adapter;
}

describe("messageQueueHandler transport selection", () => {
  test("falls back to cloud when local transport is unavailable", async () => {
    const adapter = createAdapter();
    adapter.rr_mqtt_connector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_status", [])
    ).resolves.toEqual(["ok"]);

    expect(adapter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Falling back to cloud connection")
    );
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "cloud",
        lastCommandMethod: "get_status",
      })
    );
  });

  test("uses local transport when the local socket is connected", async () => {
    const adapter = createAdapter({
      localConnector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
    });
    adapter.localConnector.sendMessage.mockImplementation(() => {
      const pending = adapter.pendingRequests.get(42);
      adapter.clearTimeout(pending.timeout);
      adapter.pendingRequests.delete(42);
      pending.resolve(["ok"]);
    });

    const handler = new messageQueueHandler(adapter);
    await expect(
      handler.sendRequest("device-1", "get_clean_record", [1])
    ).resolves.toEqual(["ok"]);

    expect(adapter.localConnector.sendMessage).toHaveBeenCalled();
    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "device-1",
      expect.objectContaining({
        lastTransport: "local",
        lastCommandMethod: "get_clean_record",
      })
    );
  });
});
