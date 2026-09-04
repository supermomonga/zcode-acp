import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NullLogger, type LogLevel, type Logger } from "../../src/diagnostics/logger.ts";
import {
  ZCodeProtocolClient,
  type NativeTransport,
} from "../../src/zcode/protocol/client.ts";

describe("ZCode private protocol client", () => {
  test("correlates requests and validates results", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(harness.transport, new NullLogger());

    const response = client.request(
      "workspace/readState",
      { workspace: "test" },
      z.object({ value: z.literal("ok") }).strict(),
    );
    await Bun.sleep(0);
    expect(harness.writes).toEqual([
      '{"id":1,"method":"workspace/readState","params":{"workspace":"test"}}\n',
    ]);

    await harness.send({ id: 1, result: { value: "ok" } });
    await expect(response).resolves.toEqual({ value: "ok" });
    await client.close();
  });

  test("times out and ignores a late response", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(harness.transport, new NullLogger());
    const response = client.request("slow", {}, z.object({}).strict(), 5);

    await expect(response).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
    await harness.send({ id: 1, result: {} });
    await client.close();
  });

  test("fails closed on an unsupported reverse request", async () => {
    const harness = transportHarness();
    const client = new ZCodeProtocolClient(harness.transport, new NullLogger());
    const pending = client.request("session/send", {}, z.object({}).strict());
    await harness.send({ id: 42, method: "interaction/unknown", params: {} });

    await expect(pending).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
  });

  test("keeps reading while an ordered notification handler performs a nested request", async () => {
    const harness = transportHarness();
    const handled = Promise.withResolvers<void>();
    let client!: ZCodeProtocolClient;
    client = new ZCodeProtocolClient(
      harness.transport,
      new NullLogger(),
      undefined,
      async () => {
        await client.request("session/read", {}, z.object({ ok: z.literal(true) }).strict());
        handled.resolve();
      },
    );
    client.start();

    await harness.send({ method: "event", params: {} });
    await Bun.sleep(0);
    expect(harness.writes).toEqual(['{"id":1,"method":"session/read","params":{}}\n']);
    await harness.send({ id: 1, result: { ok: true } });
    await handled.promise;
    await client.close();
  });

  test("records native stdio write timing without logging request contents", async () => {
    const harness = transportHarness();
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    const logger = new CaptureLogger();
    const transport: NativeTransport = {
      readable: harness.transport.readable,
      async write(frame) {
        writeStarted.resolve();
        await releaseWrite.promise;
        harness.writes.push(frame);
      },
      close: () => harness.transport.close(),
    };
    const client = new ZCodeProtocolClient(transport, logger);

    const response = client.request(
      "__call",
      { content: "PROMPT_MUST_NOT_BE_LOGGED" },
      z.object({ accepted: z.literal(true) }).strict(),
      1_000,
      { operation: "sendPrompt", sessionId: "session-1", inputId: "input-1" },
    );
    await writeStarted.promise;
    expect(logger.events("zcode.native_request.write.started")).toHaveLength(1);
    expect(logger.events("zcode.native_request.write.completed")).toHaveLength(0);

    await Bun.sleep(10);
    releaseWrite.resolve();
    await Bun.sleep(0);
    const completed = logger.events("zcode.native_request.write.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({
      operation: "sendPrompt",
      sessionId: "session-1",
      inputId: "input-1",
      nativeRequestId: 1,
    });
    expect(Number(completed[0]?.data.durationMs)).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(logger.records)).not.toContain("PROMPT_MUST_NOT_BE_LOGGED");

    await harness.send({ id: 1, result: { accepted: true } });
    await expect(response).resolves.toEqual({ accepted: true });
    await client.close();
  });
});

class CaptureLogger implements Logger {
  readonly records: Array<{ level: LogLevel; event: string; data: Record<string, unknown> }> = [];

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    this.records.push({ level, event, data });
  }

  error(event: string, error: unknown, data: Record<string, unknown> = {}): void {
    this.log("error", event, { ...data, error });
  }

  events(event: string): typeof this.records {
    return this.records.filter((record) => record.event === event);
  }
}

function transportHarness(): {
  transport: NativeTransport;
  writes: string[];
  send(value: unknown): Promise<void>;
} {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const inputWriter = input.writable.getWriter();
  const writes: string[] = [];
  const encoder = new TextEncoder();

  return {
    transport: {
      readable: input.readable,
      async write(frame) {
        writes.push(frame);
      },
      async close() {
        await inputWriter.close();
      },
    },
    writes,
    async send(value) {
      await inputWriter.write(encoder.encode(`${JSON.stringify(value)}\n`));
    },
  };
}
