const { vacuum } = require("../roborockLib/lib/vacuum");

function createAdapter(sendRequest = jest.fn().mockResolvedValue(["ok"])) {
  return {
    log: {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest,
    },
    catchError: jest.fn(),
  };
}

describe("Roborock vacuum command options", () => {
  test("passes per-command transport and timeout options to the request queue", async () => {
    const sendRequest = jest.fn().mockResolvedValue(["ok"]);
    const adapter = createAdapter(sendRequest);
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await robot.command("device-1", "app_start", null, {
      preferCloud: true,
      requestTimeoutMs: 2500,
      throwOnError: true,
    });

    expect(sendRequest).toHaveBeenCalledWith(
      "device-1",
      "app_start",
      [],
      false,
      false,
      {
        preferCloud: true,
        requestTimeoutMs: 2500,
      }
    );
  });

  test("throws command errors when requested by the caller", async () => {
    const error = new Error("Cloud request timed out");
    const adapter = createAdapter(jest.fn().mockRejectedValue(error));
    const robot = new vacuum(adapter, "roborock.vacuum.ss07");

    await expect(
      robot.command("device-1", "app_start", null, {
        throwOnError: true,
      })
    ).rejects.toThrow("Cloud request timed out");

    expect(adapter.catchError).toHaveBeenCalledWith(
      error,
      "app_start",
      "device-1",
      "roborock.vacuum.ss07"
    );
  });
});
