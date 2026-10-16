const RoborockVacuumAccessory = require("../src/vacuum_accessory").default;

const SCHEDULE_SERVICE_PREFIX = "roborock-schedule-";

class FakeCharacteristic {
  constructor(name) {
    this.name = name;
    this.value = undefined;
    this.handlers = { set: null, get: null };
  }

  onSet(handler) {
    this.handlers.set = handler;
    return this;
  }

  onGet(handler) {
    this.handlers.get = handler;
    return this;
  }

  setValue(value) {
    this.value = value;
    return this;
  }

  updateCharacteristic(value) {
    this.value = value;
    return this;
  }
}

class FakeService {
  constructor(displayName, subtype) {
    this.displayName = displayName;
    this.subtype = subtype;
    this.characteristics = new Map();
  }

  getCharacteristic(name) {
    if (!this.characteristics.has(name)) {
      this.characteristics.set(name, new FakeCharacteristic(name));
    }
    return this.characteristics.get(name);
  }

  setCharacteristic(name, value) {
    this.getCharacteristic(name).setValue(value);
    return this;
  }

  addOptionalCharacteristic() {
    return this;
  }

  addLinkedService() {
    return this;
  }

  updateCharacteristic(name, value) {
    this.getCharacteristic(name).updateCharacteristic(value);
    return this;
  }
}

// Service/Characteristic "types" are opaque tokens used as lookup keys the
// way homebridge uses the real classes.
const Service = {
  AccessoryInformation: "AccessoryInformation",
  Switch: "Switch",
  Fanv2: "Fanv2",
  Battery: "Battery",
};
const Characteristic = {
  Manufacturer: "Manufacturer",
  Model: "Model",
  SerialNumber: "SerialNumber",
  FirmwareRevision: "FirmwareRevision",
  Name: "Name",
  ConfiguredName: "ConfiguredName",
  On: "On",
  Active: "Active",
  BatteryLevel: "BatteryLevel",
  StatusLowBattery: "StatusLowBattery",
  ChargingState: "ChargingState",
};

function createAccessory() {
  const services = [];
  return {
    displayName: "Test Vacuum",
    context: { duid: "device-1" },
    services,
    getService: (type) =>
      services.find((service) => service.displayName === type),
    getServiceById: (type, subtype) =>
      services.find((service) => service.subtype === subtype),
    addService: (type, displayName, subtype) => {
      const service = new FakeService(displayName, subtype);
      services.push(service);
      return service;
    },
    removeService: (service) => {
      const index = services.indexOf(service);
      if (index >= 0) {
        services.splice(index, 1);
      }
    },
  };
}

function createPlatform(timers) {
  return {
    Service,
    Characteristic,
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    roborockAPI: {
      getVacuumDeviceInfo: (context, property) =>
        property === "name" ? "Test Vacuum" : "",
      getProductAttribute: () => "roborock.vacuum.a15",
      getVacuumDeviceStatus: () => ({}),
      getScenesForDevice: () => [],
      getServerTimers: jest.fn(() => Promise.resolve(timers)),
      updateServerTimer: jest.fn(() => Promise.resolve()),
    },
  };
}

function createHarness({ timers = [] } = {}) {
  const accessory = createAccessory();
  const platform = createPlatform(timers);
  const vacuum = new RoborockVacuumAccessory(platform, accessory);
  return { platform, accessory, vacuum };
}

function getScheduleService(accessory, scheduleId) {
  return accessory.services.find(
    (service) =>
      service.subtype ===
      `${SCHEDULE_SERVICE_PREFIX}${encodeURIComponent(scheduleId)}`
  );
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Roborock schedule switches", () => {
  test("creates one switch per schedule", async () => {
    const { accessory } = createHarness({
      timers: [
        ["100", "on", 1],
        ["200", "off", 2],
      ],
    });
    await flush();

    const first = getScheduleService(accessory, "100");
    const second = getScheduleService(accessory, "200");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.getCharacteristic(Characteristic.On).value).toBe(true);
    expect(second.getCharacteristic(Characteristic.On).value).toBe(false);
  });

  test("shares one schedule read across every switch read", async () => {
    const { platform, vacuum } = createHarness({
      timers: [["100", "on", 1]],
    });
    await flush();

    // Age the cache out so the next read must hit the API again.
    vacuum.scheduleCache = {
      schedules: [{ id: "100", enabled: true }],
      at: Date.now() - 6 * 60 * 1000,
    };
    platform.roborockAPI.getServerTimers.mockClear();

    await vacuum.getScheduleSwitch("100");
    await vacuum.getScheduleSwitch("100");
    await vacuum.getScheduleSwitch("100");

    expect(platform.roborockAPI.getServerTimers).toHaveBeenCalledTimes(1);
  });

  test("verifies a schedule write by reading the list back", async () => {
    const { platform, vacuum } = createHarness({
      timers: [["100", "off", 1]],
    });
    await flush();
    platform.roborockAPI.getServerTimers.mockClear();
    platform.roborockAPI.getServerTimers.mockResolvedValue([["100", "on", 1]]);

    await vacuum.setScheduleSwitch("100", true);

    expect(platform.roborockAPI.updateServerTimer).toHaveBeenCalledWith(
      { duid: "device-1" },
      "100",
      true
    );
    expect(platform.roborockAPI.getServerTimers).toHaveBeenCalled();
    expect(vacuum.currentSchedules.get("100")).toEqual({
      id: "100",
      enabled: true,
    });
  });

  test("reverts the switch when the robot did not apply the write", async () => {
    const { platform, vacuum, accessory } = createHarness({
      timers: [["100", "off", 1]],
    });
    await flush();
    platform.roborockAPI.getServerTimers.mockClear();
    platform.roborockAPI.getServerTimers.mockResolvedValue([["100", "off", 1]]);

    await vacuum.setScheduleSwitch("100", true);

    expect(vacuum.currentSchedules.get("100")).toEqual({
      id: "100",
      enabled: false,
    });
    const service = getScheduleService(accessory, "100");
    expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
  });

  test("keeps the optimistic state when the verification read fails", async () => {
    const { platform, vacuum } = createHarness({
      timers: [["100", "off", 1]],
    });
    await flush();
    platform.roborockAPI.getServerTimers.mockClear();
    platform.roborockAPI.getServerTimers.mockRejectedValue(
      new Error("Request timed out")
    );

    await vacuum.setScheduleSwitch("100", true);

    expect(vacuum.currentSchedules.get("100")).toEqual({
      id: "100",
      enabled: true,
    });
  });

  test("keeps a user-renamed ConfiguredName on sync", async () => {
    const { accessory, platform } = createHarness({
      timers: [["100", "on", 1]],
    });
    await flush();

    const service = getScheduleService(accessory, "100");
    service
      .getCharacteristic(Characteristic.ConfiguredName)
      .setValue("Morning Clean");

    platform.roborockAPI.getServerTimers.mockResolvedValue([["100", "on", 1]]);
    const vacuum2 = new RoborockVacuumAccessory(platform, accessory);
    await flush();

    const synced = getScheduleService(accessory, "100");
    expect(
      String(synced.getCharacteristic(Characteristic.ConfiguredName).value)
    ).toBe("Morning Clean");
  });

  test("updates a default ConfiguredName when the schedule index moves", async () => {
    const { accessory, platform } = createHarness({
      timers: [["100", "on", 1]],
    });
    await flush();

    const service = getScheduleService(accessory, "100");
    expect(
      String(service.getCharacteristic(Characteristic.ConfiguredName).value)
    ).toBe("Roborock Schedule 1");

    platform.roborockAPI.getServerTimers.mockResolvedValue([
      ["300", "on", 5],
      ["100", "on", 1],
    ]);
    const vacuum2 = new RoborockVacuumAccessory(platform, accessory);
    await flush();

    const synced = getScheduleService(accessory, "100");
    expect(
      String(synced.getCharacteristic(Characteristic.ConfiguredName).value)
    ).toBe("Roborock Schedule 2");
  });

  test("keeps existing switches when a reading parses to an empty list", async () => {
    const { accessory, platform } = createHarness({
      timers: [["100", "on", 1]],
    });
    await flush();
    expect(getScheduleService(accessory, "100")).toBeDefined();

    platform.roborockAPI.getServerTimers.mockResolvedValue([]);
    const vacuum2 = new RoborockVacuumAccessory(platform, accessory);
    await flush();

    expect(getScheduleService(accessory, "100")).toBeDefined();
  });
});
