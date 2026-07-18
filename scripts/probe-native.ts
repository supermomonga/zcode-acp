#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { NullLogger } from "../src/diagnostics/logger.ts";
import { discoverRuntime } from "../src/zcode/discovery/discover.ts";
import {
  ZCodeProtocolClient,
  type NativeTransport,
} from "../src/zcode/protocol/client.ts";

const SAFE_VALUE_KEYS = new Set([
  "type",
  "kind",
  "status",
  "mode",
  "reason",
  "riskLevel",
  "deliveryKind",
  "titleSource",
  "toolName",
  "optionId",
  "name",
  "providerId",
  "modelId",
  "protocolVersion",
  "accepted",
  "headersApplied",
  "changed",
]);
const REDACTED_KEYS = /(?:content|input|output|header|secret|token|credential|cookie|apiKey|prompt)/i;

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the native contract probe");
}

const shouldSend = process.argv.includes("--send");
const workspacePath = await mkdtemp(join(tmpdir(), "zcode-acp-contract-"));
const workspace = { workspacePath, workspaceKey: workspacePath };
const runtime = await discoverRuntime();
const child = Bun.spawn(
  [runtime.paths.executable, runtime.paths.cliEntry, "app-server", "--stdio"],
  {
    cwd: workspacePath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
);
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

const events: unknown[] = [];
const client = new ZCodeProtocolClient(
  transport,
  new NullLogger(),
  async (request) => {
    process.stdout.write(
      `${JSON.stringify({ reverseRequest: request.method, params: summarize(request.params) })}\n`,
    );
    if (request.method === "interaction/requestProviderRuntimeHeaders") {
      return { headersApplied: false, errorMessage: "Contract probe does not apply runtime headers" };
    }
    throw new Error(`Contract probe refuses reverse request: ${request.method}`);
  },
  (notification) => {
    events.push(notification);
    process.stdout.write(
      `${JSON.stringify({ notification: notification.method, params: summarize(notification.params) })}\n`,
    );
  },
);

try {
  const state = await client.request(
    "workspace/readState",
    { workspace },
    z.unknown(),
  );
  process.stdout.write(`${JSON.stringify({ workspaceReadState: summarize(state) })}\n`);

  const snapshot = await client.request(
    "session/create",
    { workspace, mode: "plan", persistence: "deferred" },
    z.unknown(),
  );
  process.stdout.write(`${JSON.stringify({ sessionCreate: summarize(snapshot) })}\n`);
  const sessionId = extractSessionId(snapshot);

  const subscription = await client.request(
    "session/subscribe",
    {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: true,
    },
    z.unknown(),
  );
  process.stdout.write(`${JSON.stringify({ sessionSubscribe: summarize(subscription) })}\n`);

  if (shouldSend) {
    const send = await client.request(
      "session/send",
      {
        sessionId,
        inputId: crypto.randomUUID(),
        content: "Reply with exactly: ZCODE_ACP_PROBE_OK. Do not use tools.",
      },
      z.unknown(),
    );
    process.stdout.write(`${JSON.stringify({ sessionSend: summarize(send) })}\n`);
    await waitForTerminal(events, sessionId, 120_000);
  }

  await client.request("session/close", { sessionId }, z.unknown());
} finally {
  await client.close().catch(() => undefined);
  await Promise.race([child.exited, Bun.sleep(3_000)]);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await rm(workspacePath, { recursive: true, force: true });
}

function extractSessionId(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "session" in value &&
    typeof value.session === "object" &&
    value.session !== null &&
    "sessionId" in value.session &&
    typeof value.session.sessionId === "string"
  ) {
    return value.session.sessionId;
  }
  throw new Error("session/create did not return a session ID");
}

async function waitForTerminal(
  source: unknown[],
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (source.some((item) => isTerminalNotification(item, sessionId))) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for a terminal session event");
}

function isTerminalNotification(value: unknown, sessionId: string): boolean {
  if (typeof value !== "object" || value === null || !("params" in value)) {
    return false;
  }
  const params = value.params;
  if (typeof params !== "object" || params === null || !("event" in params)) {
    return false;
  }
  const event = params.event;
  return (
    typeof event === "object" &&
    event !== null &&
    "sessionId" in event &&
    event.sessionId === sessionId &&
    "type" in event &&
    (event.type === "turn.completed" || event.type === "turn.failed")
  );
}

function summarize(value: unknown, key = "root"): unknown {
  if (REDACTED_KEYS.test(key)) {
    return `[REDACTED:${describe(value)}]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarize(item, key));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, summarize(child, childKey)]),
    );
  }
  if (typeof value === "string") {
    return SAFE_VALUE_KEYS.has(key) ? value : `[STRING:${value.length}]`;
  }
  return value;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return `array:${value.length}`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return `object:${Object.keys(value).join(",")}`;
  }
  return typeof value;
}
