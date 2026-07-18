import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNdjson } from "../src/zcode/protocol/ndjson.ts";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the safety probe");
}

const workspace = await mkdtemp(join(tmpdir(), "zcode-acp-safety-"));
const executable = process.env.ZCODE_ACP_PROBE_EXECUTABLE;
const probeCwd = process.env.ZCODE_ACP_PROBE_CWD ?? import.meta.dir.replace(/\/scripts$/, "");
const child = Bun.spawn(executable ? [executable] : ["bun", "run", "src/cli.ts"], {
  cwd: probeCwd,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
const stderrPromise = new Response(child.stderr).text();
const frames = readNdjson(child.stdout);

const write = async (message: unknown): Promise<void> => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.flush();
};
const next = async (): Promise<Record<string, unknown>> => {
  const value = await frames.next();
  if (value.done || typeof value.value !== "object" || value.value === null) {
    throw new Error("ACP stdout closed during safety probe");
  }
  return value.value as Record<string, unknown>;
};
const response = async (id: number): Promise<Record<string, unknown>> => {
  while (true) {
    const frame = await next();
    if (frame.id === id) return frame;
  }
};

try {
  await write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  });
  await response(1);
  await write({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: workspace, mcpServers: [] },
  });
  const created = await response(2);
  const sessionId = (created.result as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string") throw new Error(JSON.stringify(created));

  const runPermissionPrompt = async (
    id: number,
    prompt: string,
    allow: boolean,
  ): Promise<{ permissionCount: number; stopReason: unknown; error?: unknown }> => {
    await write({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: prompt }] },
    });
    let permissionCount = 0;
    while (true) {
      const frame = await next();
      if (frame.method === "session/request_permission") {
        permissionCount += 1;
        const params = frame.params as { options?: Array<{ optionId?: string; kind?: string }> };
        const selected = allow
          ? params.options?.find((option) => option.kind === "allow_once")
          : undefined;
        await write({
          jsonrpc: "2.0",
          id: frame.id,
          result: selected
            ? { outcome: { outcome: "selected", optionId: selected.optionId } }
            : { outcome: { outcome: "cancelled" } },
        });
        continue;
      }
      if (frame.id === id) {
        return {
          permissionCount,
          stopReason: (frame.result as { stopReason?: unknown } | undefined)?.stopReason,
          ...(frame.error === undefined ? {} : { error: frame.error }),
        };
      }
    }
  };

  const allowedPath = join(workspace, "allowed.txt");
  const allowed = await runPermissionPrompt(
    3,
    `Create ${allowedPath} with the exact text allowed using a file-writing tool. Do not ask questions.`,
    true,
  );
  if (allowed.permissionCount === 0 || (await readFile(allowedPath, "utf8")) !== "allowed") {
    throw new Error(`Allow path failed: ${JSON.stringify(allowed)}`);
  }

  const deniedPath = join(workspace, "denied.txt");
  const denied = await runPermissionPrompt(
    4,
    `Create ${deniedPath} with the exact text denied using a file-writing tool. Do not ask questions.`,
    false,
  );
  let deniedExists = true;
  try {
    await stat(deniedPath);
  } catch (error) {
    deniedExists = (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (denied.permissionCount === 0 || deniedExists) {
    throw new Error(`Deny path failed: ${JSON.stringify(denied)}`);
  }

  await write({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: "Write an extremely long numbered list from 1 to 10000." }],
    },
  });
  const cancelTimer = setTimeout(() => {
    void write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }, 500);
  let cancelStopReason: unknown;
  while (cancelStopReason === undefined) {
    const frame = await next();
    if (frame.method === "session/request_permission") {
      await write({
        jsonrpc: "2.0",
        id: frame.id,
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    if (frame.id === 5) {
      cancelStopReason = (frame.result as { stopReason?: unknown } | undefined)?.stopReason;
    }
  }
  clearTimeout(cancelTimer);
  if (cancelStopReason !== "cancelled") {
    throw new Error(`Cancel path failed: ${String(cancelStopReason)}`);
  }

  process.stdout.write(`${JSON.stringify({
    allowedPermissions: allowed.permissionCount,
    deniedPermissions: denied.permissionCount,
    cancelStopReason,
  })}\n`);
  await child.stdin.end();
  if (await child.exited !== 0) throw new Error("ACP process did not shut down cleanly");
} catch (error) {
  if (child.exitCode === null) child.kill("SIGTERM");
  const stderr = await stderrPromise;
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.slice(-4_000)}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(workspace, { recursive: true, force: true });
}
