import { describe, expect, test } from "bun:test";
import { readNdjson } from "../../src/zcode/protocol/ndjson.ts";

describe("native NDJSON framing", () => {
  test("handles partial chunks, CRLF, and empty lines", async () => {
    const stream = streamFromChunks(["{\"id\":", "1}\r\n\n{\"id\":2}\n"]);
    expect(await collect(stream)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("accepts a final frame without a newline", async () => {
    expect(await collect(streamFromChunks(["{\"ok\":true}"]))).toEqual([{ ok: true }]);
  });

  test("rejects non-JSON stdout", async () => {
    await expect(collect(streamFromChunks(["not json\n"]))).rejects.toMatchObject({
      code: "NATIVE_PROTOCOL_ERROR",
    });
  });

  test("rejects oversized frames", async () => {
    await expect(collect(streamFromChunks(["{\"value\":\"large\"}\n"]), 4)).rejects.toMatchObject({
      code: "NATIVE_PROTOCOL_ERROR",
    });
  });
});

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of readNdjson(stream, maxBytes)) {
    values.push(value);
  }
  return values;
}

