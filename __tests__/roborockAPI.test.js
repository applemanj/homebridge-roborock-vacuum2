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
});
