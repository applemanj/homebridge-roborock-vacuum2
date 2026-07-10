const { parseServerTimers } = require("../src/vacuum_accessory");

describe("Roborock schedule parsing", () => {
  test("maps valid server timer tuples to schedule states", () => {
    expect(
      parseServerTimers([
        ["weekday", "on", 123],
        ["weekend", "off", 456],
      ])
    ).toEqual([
      { id: "weekday", enabled: true },
      { id: "weekend", enabled: false },
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
    ).toEqual([{ id: "valid", enabled: true }]);
    expect(parseServerTimers(null)).toEqual([]);
  });
});
