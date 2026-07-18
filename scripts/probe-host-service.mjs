import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

if (process.env.ZCODE_ACP_ENABLE_CONTRACT_PROBE !== "1") {
  throw new Error("Set ZCODE_ACP_ENABLE_CONTRACT_PROBE=1 to run the native host probe");
}

const resources = process.env.ZCODE_ACP_ZCODE_RESOURCES
  ?? "/Applications/ZCode.app/Contents/Resources";
const hostRoot = join(resources, "app.asar", "out", "host");
const hostIndexUrl = pathToFileURL(join(hostRoot, "index.js")).href;
const rpcModule = await import(pathToFileURL(join(hostRoot, "chunk-HAEWO5CB.js")).href);

const workspacePath = await mkdtemp(join(tmpdir(), "zcode-acp-host-probe-"));
const worker = new Worker(new URL("./zcode-host-worker.mjs", import.meta.url), {
  workerData: { hostIndexUrl },
  stdout: true,
  stderr: true,
});
const { port1, port2 } = new MessageChannel();
const protocol = new rpcModule.g(port1);
const client = new rpcModule.i(protocol);
const service = rpcModule.j.toService(client.getChannel("zcode-agent"));

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

worker.stdout.resume();
worker.stderr.resume();
worker.on("error", (error) => log("worker.error", { message: error.message, stack: error.stack }));

try {
  worker.postMessage({
    data: {
      type: "init-local",
      deviceMid: "zcode-acp-headless-probe",
      workspacePath,
      agentSpawnFallbackCwd: workspacePath,
    },
    ports: [port2],
  }, [port2]);

  const warmupMs = Number(process.env.ZCODE_ACP_PROBE_WARMUP_MS ?? "0");
  if (warmupMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, warmupMs));
  }

  const initialized = await service.initialize({ workspacePath });
  log("initialize", initialized);
  const state = await service.readWorkspaceState({ workspacePath });
  log("readWorkspaceState", state);
  const snapshot = await service.createSession({
    workspacePath,
    persistence: "deferred",
  });
  log("createSession", snapshot);
  const sessionId = snapshot.session.sessionId;
  log("listSessions", await service.listSessions({
    workspacePath,
    includeArchived: false,
    limit: 20,
  }));
  log("readSession", await service.readSession({
    workspacePath,
    sessionId,
    deliveryKind: "desktop-continuous",
    messageLimit: 100,
    afterSeq: 0,
  }));
  log("readSessionMessages", await service.readSessionMessages({
    workspacePath,
    sessionId,
    limit: 100,
  }));
  log("resumeSession", await service.resumeSession({ workspacePath, sessionId }));
  const terminal = Promise.withResolvers();
  const subscription = service.onDynamicSessionEvent({
    workspacePath,
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: true,
  })((event) => {
    log("event", event);
    if (event.type === "permission.request") {
      const option = event.request.options.find((candidate) =>
        candidate.response?.decision === "deny"
      );
      void service.respondPermission({
        workspacePath,
        sessionId,
        requestId: event.request.requestId,
        response: option?.response ?? { decision: "deny", reason: "Contract probe" },
      });
    }
    if (event.type === "userInput.request") {
      void service.respondUserInput({
        workspacePath,
        sessionId,
        requestId: event.request.requestId,
        response: { action: "decline", reason: "Contract probe" },
      });
    }
    if (event.type === "providerRuntimeHeaders.request") {
      void service.respondProviderRuntimeHeaders({
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
  const ack = await service.sendPrompt({
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
  subscription.dispose();
} finally {
  protocol.disconnect();
  await worker.terminate();
  await rm(workspacePath, { recursive: true, force: true });
}
