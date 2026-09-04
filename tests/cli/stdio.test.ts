import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("mirrors diagnostics to the configured file without contaminating ACP stdout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-acp-stdio-"));
    const logFile = join(directory, "diagnostics.jsonl");
    try {
      const child = Bun.spawn(["bun", "run", "src/cli.ts"], {
        cwd: import.meta.dir.replace(/\/tests\/cli$/, ""),
        env: {
          ...process.env,
          ZCODE_ACP_LOG_LEVEL: "debug",
          ZCODE_ACP_LOG_FILE: logFile,
        },
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
      expect(stdout.trim().split("\n").filter(Boolean)).toHaveLength(1);
      expect(stdout).not.toContain("acp.initialize");

      const records = readFileSync(logFile, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(expect.objectContaining({
        event: "acp.initialize",
        pid: child.pid,
      }));
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
