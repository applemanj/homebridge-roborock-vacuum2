const {
  hapName,
  HAP_NAME_PATTERN,
  HAP_NAME_MAX_LENGTH,
} = require("../src/hap_name");
const { redactSecrets, REDACTED } = require("../src/redact_secrets");

describe("hapName", () => {
  test("returns a name HAP already accepts unchanged", () => {
    expect(hapName("Vicky", "Roborock Vacuum")).toBe("Vicky");
    expect(hapName("Q5 Max", "Roborock Vacuum")).toBe("Q5 Max");
    expect(hapName("S8 Pro Ultra", "Roborock Vacuum")).toBe("S8 Pro Ultra");
  });

  test("reads '+' as ' Plus '", () => {
    expect(hapName("Q5 Max+", "Roborock Vacuum")).toBe("Q5 Max Plus");
  });

  test("replaces unsupported characters with spaces and collapses whitespace", () => {
    expect(hapName("Vicky\tRobot\n#1", "Roborock Vacuum")).toBe(
      "Vicky Robot 1"
    );
  });

  test("trims to start and end with a letter or number", () => {
    expect(hapName("  (Vicky)  ", "Roborock Vacuum")).toBe("Vicky");
  });

  test("keeps a suffix within the 64-character budget", () => {
    const long = "a".repeat(80);
    const result = hapName(long, "Roborock Vacuum", "Docked");
    expect(result.length).toBeLessThanOrEqual(HAP_NAME_MAX_LENGTH);
    expect(result.endsWith(" Docked")).toBe(true);
  });

  test("falls back when fewer than two characters remain", () => {
    expect(hapName("", "Roborock Vacuum")).toBe("Roborock Vacuum");
    expect(hapName("#", "Roborock Vacuum")).toBe("Roborock Vacuum");
    expect(hapName(undefined, "Roborock Vacuum")).toBe("Roborock Vacuum");
  });

  test("keeps combining marks rather than dropping them", () => {
    // Thai "นิว" with a combining vowel mark: dropping the mark would change
    // the word.
    expect(hapName("นิว", "Roborock Vacuum")).toBe("นิว");
  });

  test("HAP_NAME_PATTERN accepts the sanitized output", () => {
    // Note: a name with a combining mark (Thai, Hindi) can keep the mark and
    // still fail the pattern's middle class — dropping the mark would change
    // the word, so hapName keeps it. That case is asserted separately above.
    for (const input of ["Q5 Max+", "  (Vicky)  ", "a".repeat(80)]) {
      expect(HAP_NAME_PATTERN.test(hapName(input, "Roborock Vacuum"))).toBe(
        true
      );
    }
  });
});

describe("redactSecrets", () => {
  test("redacts known secret keys", () => {
    const input = {
      duid: "abc123",
      localKey: "supersecret",
      sn: "RK123456",
      name: "Vicky",
    };
    const output = redactSecrets(input);
    expect(output).toEqual({
      duid: "abc123",
      localKey: REDACTED,
      sn: REDACTED,
      name: "Vicky",
    });
  });

  test("redacts nested JSON inside strings", () => {
    const inner = JSON.stringify({ token: "abc", value: 1 });
    const input = { val: inner, ack: true };
    const output = redactSecrets(input);
    expect(JSON.parse(output.val)).toEqual({ token: REDACTED, value: 1 });
    expect(output.ack).toBe(true);
  });

  test("never mutates its input", () => {
    const input = { localKey: "supersecret", nested: { sn: "RK123" } };
    redactSecrets(input);
    expect(input).toEqual({
      localKey: "supersecret",
      nested: { sn: "RK123" },
    });
  });

  test("redacts the whole rriot block", () => {
    const input = { rriot: { h: "hmac", k: "mqtt", u: "user" } };
    expect(redactSecrets(input)).toEqual({ rriot: REDACTED });
  });

  test("handles arrays and deep nesting", () => {
    const input = [{ token: "a" }, { list: [{ password: "b" }] }];
    expect(redactSecrets(input)).toEqual([
      { token: REDACTED },
      { list: [{ password: REDACTED }] },
    ]);
  });

  test("leaves primitives and null alone", () => {
    expect(redactSecrets("plain string")).toBe("plain string");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });
});
