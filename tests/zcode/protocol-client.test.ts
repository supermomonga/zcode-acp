import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NullLogger } from "../../src/diagnostics/logger.ts";
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
});

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
