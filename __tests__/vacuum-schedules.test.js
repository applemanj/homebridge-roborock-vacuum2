const { parseServerTimers } = require("../src/vacuum_accessory");

describe("Roborock schedule parsing", () => {
  test("maps valid server timer tuples to schedule states", () => {
    expect(
      parseServerTimers([
        ["weekday", "on", 123],
        ["weekend", "off", 456],
      ])
    ).toEqual([
      { id: "weekday", enabled: true, timer: ["weekday", "on", 123] },
      { id: "weekend", enabled: false, timer: ["weekend", "off", 456] },
    ]);
  });

  test("ignores malformed, unknown, and duplicate timer entries", () => {
    expect(
      parseServerTimers([
        ["valid", "on", 123],
        ["valid", "off", 456],
        ["unknown", "paused", 789],
        [null, "on", 111],
        "invalid",
      ])
    ).toEqual([{ id: "valid", enabled: true, timer: ["valid", "on", 123] }]);
    expect(parseServerTimers(null)).toEqual([]);
  });
});
