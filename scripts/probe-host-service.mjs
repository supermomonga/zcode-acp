import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NullLogger } from "../src/diagnostics/logger.ts";
import { discoverRuntime } from "../src/zcode/discovery/discover.ts";
import { ZCodeHostBridge } from "../src/zcode/host/bridge.ts";
import { z } from "zod";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the native host probe");
}

const runtime = await discoverRuntime();
if (runtime.hostContract === undefined) {
  throw new Error(`No investigated host contract: ${runtime.compatibilityReason}`);
}
const workspacePath = await mkdtemp(join(tmpdir(), "zcode-acp-host-probe-"));
await writeFile(
  join(workspacePath, "package.json"),
  `${JSON.stringify({ name: "zcode-acp-host-probe" })}\n`,
  "utf8",
);
const bridge = ZCodeHostBridge.start(
  runtime,
  new NullLogger(),
  process.env,
  { allowDevelopmentCandidate: true },
);
const AnySchema = z.unknown();
const call = (method, params) => bridge.request(method, params, AnySchema, 60_000);

const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/authorization|api.?key|credential|header|secret|token/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, redact(entry)];
  }));
};

const log = (label, value) => {
  process.stdout.write(`${JSON.stringify({ label, value: redact(value) })}\n`);
};

try {
  const warmupMs = Number(process.env.ZCODE_ACP_PROBE_WARMUP_MS ?? "0");
  if (warmupMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, warmupMs));
  }

  const initialized = await call("initialize", { workspacePath });
  log("initialize", initialized);
  const state = await call("readWorkspaceState", { workspacePath });
  log("readWorkspaceState", state);
  const snapshot = await call("createSession", {
    workspacePath,
    persistence: "deferred",
  });
  log("createSession", snapshot);
  const sessionId = snapshot.session.sessionId;
  log("listSessions", await call("listSessions", {
    workspacePath,
    includeArchived: false,
    limit: 20,
  }));
  log("readSession", await call("readSession", {
    workspacePath,
    sessionId,
    deliveryKind: "desktop-continuous",
    messageLimit: 100,
    afterSeq: 0,
  }));
  log("readSessionMessages", await call("readSessionMessages", {
    workspacePath,
    sessionId,
    limit: 100,
  }));
  log("resumeSession", await call("resumeSession", { workspacePath, sessionId }));
  const terminal = Promise.withResolvers();
  const subscription = await bridge.subscribe({
    workspacePath,
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: true,
  }, (event) => {
    log("event", event);
    if (event.type === "permission.request") {
      const option = event.request.options.find((candidate) =>
        candidate.response?.decision === "deny"
      );
      const selected = option ?? event.request.options[0];
      void call("respondPermission", {
        workspacePath,
        sessionId,
        requestId: event.request.requestId,
        optionId: selected.optionId,
        response: selected.response,
      });
    }
    if (event.type === "userInput.request") {
      void call("respondStructuredInput", {
        workspacePath,
        sessionId,
        requestId: event.request.requestId,
        response: { action: "decline", reason: "Contract probe" },
      });
    }
    if (event.type === "providerRuntimeHeaders.request") {
      void call("respondProviderRuntimeHeaders", {
        workspacePath,
        sessionId,
        requestId: event.request.requestId,
        response: { headersApplied: false, errorMessage: "Headless captcha unsupported" },
      });
    }
    if (event.type === "session.event" &&
      (event.event.type === "turn.completed" || event.event.type === "turn.failed")) {
      terminal.resolve(event.event);
    }
  });
  const inputId = randomUUID();
  const ack = await call("sendPrompt", {
    workspacePath,
    sessionId,
    inputId,
    content: "Use the read tool to inspect package.json, then reply with only its package name. Do not modify files.",
  });
  log("sendPrompt", ack);
  await Promise.race([
    terminal.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Prompt probe timed out")), 120_000)),
  ]);
  await subscription.dispose();
} finally {
  await bridge.close();
  await rm(workspacePath, { recursive: true, force: true });
}
