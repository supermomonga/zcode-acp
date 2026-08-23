import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNdjson } from "../src/zcode/protocol/ndjson.ts";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the structured input probe");
}

const workspace = await mkdtemp(join(tmpdir(), "zcode-acp-structured-input-"));
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
    throw new Error("ACP stdout closed during structured input probe");
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
    params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
  });
  const initialized = await response(1);
  if (initialized.error !== undefined) throw new Error(JSON.stringify(initialized));
  await write({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: workspace, mcpServers: [] },
  });
  const created = await response(2);
  const sessionId = (created.result as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string") throw new Error(JSON.stringify(created));

  await write({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{
        type: "text",
        text: "Call the AskUserQuestion tool now. Ask which color to use with exactly two options whose values are red and blue. Do not choose for me. After receiving my answer, reply with exactly SELECTED:blue.",
      }],
    },
  });

  let elicitationCount = 0;
  let text = "";
  let done = false;
  while (!done) {
    const frame = await next();
    if (frame.method === "elicitation/create") {
      elicitationCount += 1;
      const params = frame.params as {
        requestedSchema?: { properties?: Record<string, unknown> };
      };
      if (!("answer_0" in (params.requestedSchema?.properties ?? {}))) {
        throw new Error(`Unexpected elicitation schema: ${JSON.stringify(frame)}`);
      }
      await write({
        jsonrpc: "2.0",
        id: frame.id,
        result: { action: "accept", content: { answer_0: "blue" } },
      });
      continue;
    }
    if (frame.method === "session/update") {
      const update = (frame.params as { update?: Record<string, unknown> }).update;
      if (update?.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { text?: unknown } | undefined;
        if (typeof content?.text === "string") text += content.text;
      }
      continue;
    }
    if (frame.id === 3) {
      if (frame.error !== undefined) throw new Error(JSON.stringify(frame));
      done = true;
    }
  }

  if (elicitationCount !== 1 || !text.includes("SELECTED:blue")) {
    throw new Error(JSON.stringify({ elicitationCount, text }));
  }
  process.stdout.write(`${JSON.stringify({ sessionId, elicitationCount, text })}\n`);
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
