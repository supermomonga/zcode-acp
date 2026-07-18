import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import {
  ZCodeProtocolClient,
  type NativeTransport,
} from "../../src/zcode/protocol/client.ts";

describe("fake ZCode child integration", () => {
  test("round-trips NDJSON over a spawned stdio process", async () => {
    const repositoryRoot = import.meta.dir.replace(/\/tests\/zcode$/, "");
    const child = Bun.spawn(["bun", "run", "tests/fixtures/fake-zcode-server.ts"], {
      cwd: repositoryRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const transport: NativeTransport = {
      readable: child.stdout,
      async write(frame) {
        child.stdin.write(frame);
        await child.stdin.flush();
      },
      async close() {
        await child.stdin.end();
      },
    };
    const client = new ZCodeProtocolClient(transport, new NullLogger());

    const result = await client.request(
      "workspace/readState",
      {},
      z
        .object({
          method: z.literal("workspace/readState"),
          cwd: z.literal(repositoryRoot),
          electronRunAsNode: z.literal(true),
        })
        .strict(),
    );

    expect(result).toEqual({
      method: "workspace/readState",
      cwd: repositoryRoot,
      electronRunAsNode: true,
    });
    await client.close();
    await expect(child.exited).resolves.toBe(0);
  });
});

