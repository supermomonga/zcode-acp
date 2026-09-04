import { describe, expect, test } from "bun:test";
import { HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE } from "../../src/zcode/host/runtime-source.ts";

type WorkerMessageHandler = (message: unknown) => void;

function createHarness() {
  let messageHandler: WorkerMessageHandler | undefined;
  const posted: unknown[] = [];
  const worker = {
    on(event: string, handler: WorkerMessageHandler) {
      if (event === "message") messageHandler = handler;
    },
    postMessage(message: unknown) {
      posted.push(message);
    },
  };

  Function("worker", HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE)(worker);
  if (messageHandler === undefined) throw new Error("message handler was not registered");
  return { handle: messageHandler, posted };
}

describe("headless ZCode host worker messages", () => {
  test("rejects browser execution immediately without copying the request payload", () => {
    const harness = createHarness();

    harness.handle({
      type: "browser-execute-request",
      requestId: "browser-request-1",
      command: { method: "navigate", url: "https://secret.example" },
    });

    expect(harness.posted).toEqual([{
      data: {
        type: "browser-execute-result",
        requestId: "browser-request-1",
        result: {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "Browser control is unavailable in zcode-acp headless mode",
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
      },
      ports: [],
    }]);
    expect(JSON.stringify(harness.posted)).not.toContain("secret.example");
  });

  test("ignores unknown messages and invalid request IDs", () => {
    const harness = createHarness();

    harness.handle({ type: "log", requestId: "log-1" });
    harness.handle({ type: "browser-execute-request" });
    harness.handle({ type: "browser-execute-request", requestId: "" });
    harness.handle({ type: "browser-execute-request", requestId: 1 });

    expect(harness.posted).toEqual([]);
  });
});
