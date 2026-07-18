import { readNdjson } from "../src/zcode/protocol/ndjson.ts";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the ACP probe");
}

const executable = process.env.ZCODE_ACP_PROBE_EXECUTABLE;
const probeCwd = process.env.ZCODE_ACP_PROBE_CWD ?? import.meta.dir.replace(/\/scripts$/, "");
const child = Bun.spawn(executable ? [executable] : ["bun", "run", "src/cli.ts"], {
  cwd: probeCwd,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const write = async (message: unknown): Promise<void> => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.flush();
};

const frames = readNdjson(child.stdout);
const next = async (): Promise<Record<string, unknown>> => {
  const value = await frames.next();
  if (value.done || typeof value.value !== "object" || value.value === null) {
    throw new Error("ACP stdout closed before the probe completed");
  }
  return value.value as Record<string, unknown>;
};

await write({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: {} },
});
const initialized = await next();
if (initialized.id !== 1 || typeof initialized.result !== "object") {
  throw new Error(`ACP initialize failed: ${JSON.stringify(initialized)}`);
}

await write({
  jsonrpc: "2.0",
  id: 2,
  method: "session/new",
  params: { cwd: process.cwd(), mcpServers: [] },
});
const created = await next();
const sessionId = (created.result as { sessionId?: unknown } | undefined)?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error(`ACP session/new failed: ${JSON.stringify(created)}`);
}

await write({
  jsonrpc: "2.0",
  id: 3,
  method: "session/prompt",
  params: {
    sessionId,
    prompt: [{
      type: "text",
      text: "Use the read tool to inspect package.json, then reply with exactly its name field and nothing else.",
    }],
  },
});

let text = "";
let toolCreated = false;
let toolCompleted = false;
let promptResponse: Record<string, unknown> | undefined;
while (promptResponse === undefined) {
  const frame = await next();
  if (frame.method === "session/update") {
    const params = frame.params as { update?: Record<string, unknown> };
    const update = params.update;
    if (update?.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { text?: unknown } | undefined;
      if (typeof content?.text === "string") text += content.text;
    }
    if (update?.sessionUpdate === "tool_call") toolCreated = true;
    if (update?.sessionUpdate === "tool_call_update" && update.status === "completed") {
      toolCompleted = true;
    }
    continue;
  }
  if (frame.method === "session/request_permission") {
    const params = frame.params as { options?: Array<{ optionId?: string; kind?: string }> };
    const selected = params.options?.find((option) => option.kind === "allow_once");
    await write({
      jsonrpc: "2.0",
      id: frame.id,
      result: selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } },
    });
    continue;
  }
  if (frame.id === 3) promptResponse = frame;
}

const stopReason = (promptResponse.result as { stopReason?: unknown } | undefined)?.stopReason;
if (stopReason !== "end_turn" || !toolCreated || !toolCompleted || text.trim() !== "zcode-acp") {
  throw new Error(JSON.stringify({ stopReason, toolCreated, toolCompleted, text, promptResponse }));
}

process.stdout.write(`${JSON.stringify({ sessionId, stopReason, toolCreated, toolCompleted, text })}\n`);
await child.stdin.end();
const exitCode = await child.exited;
if (exitCode !== 0) {
  const stderr = await new Response(child.stderr).text();
  throw new Error(`ACP process exited ${exitCode}: ${stderr.slice(-2_000)}`);
}
