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
    updateRoomMappingCache: jest.fn(),
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

  test("updates the shared room mapping cache after reading room mappings", async () => {
    const adapter = createAdapter([[101, 55]]);
    adapter.roomIDs = { 55: "Kitchen" };
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.getParameter("device-1", "get_room_mapping");

    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith("device-1", 2, [
      [101, 55],
    ]);
  });

  test("sends direct room segment clean commands for Matter service areas", async () => {
    const adapter = createAdapter([]);
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await robot.command("device-1", "app_segment_clean_by_ids", {
      segments: [101, "102", 101, "bad"],
      repeat: 2,
    });

    expect(adapter.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "device-1",
      "app_segment_clean",
      [{ segments: [101, 102], repeat: 2 }]
    );
  });
});
