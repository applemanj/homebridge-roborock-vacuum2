const { vacuum } = require("../roborockLib/lib/vacuum");

function createAdapter(mappedRooms) {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest: jest.fn((duid, method) => {
        if (method === "get_status") {
          return Promise.resolve([{ map_status: 8 }]);
        }
        if (method === "get_room_mapping") {
          return Promise.resolve(mappedRooms);
        }
        return Promise.resolve([]);
      }),
    },
    roomIDs: {},
    createStateObjectHelper: jest.fn().mockResolvedValue(undefined),
    setStateAsync: jest.fn().mockResolvedValue(undefined),
    vacuums: {
      "device-1": {
        features: {
          getConsumablesDivider: jest.fn(),
          getStatusDivider: jest.fn(),
          processDockType: jest.fn(),
          getFirmwareFeature: jest.fn(),
        },
      },
    },
  };
}

describe("vacuum room mapping", () => {
  test("creates fallback room names when HomeData is missing room labels", async () => {
    const adapter = createAdapter([[101, 55]]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.createStateObjectHelper).toHaveBeenCalledWith(
      "Devices.device-1.floors.2.101",
      "Room 55",
      "boolean",
      null,
      true,
      "value",
      true,
      true
    );
    expect(adapter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Using fallback labels")
    );
  });

  test("logs an info message instead of warning when no room mappings are returned", async () => {
    const adapter = createAdapter([]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.log.info).toHaveBeenCalledWith(
      expect.stringContaining("No room mappings returned")
    );
    expect(adapter.log.warn).not.toHaveBeenCalled();
  });
});
