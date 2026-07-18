import { describe, expect, test } from "bun:test";

describe("ACP stdio CLI", () => {
  test("keeps stdout restricted to JSON-RPC frames", async () => {
    const child = Bun.spawn(["bun", "run", "src/cli.ts"], {
      cwd: import.meta.dir.replace(/\/tests\/cli$/, ""),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`,
    );
    await child.stdin.end();

    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: 1 },
    });
  });
});
