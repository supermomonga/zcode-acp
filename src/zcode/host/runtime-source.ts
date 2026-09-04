const ZCODE_HOST_WORKER_SOURCE = String.raw`
import { parentPort, workerData } from "node:worker_threads";
if (!parentPort) throw new Error("ZCode host worker requires a parent port");
const outerListeners = new Map();
function wrapPort(port) {
  const listeners = new Map();
  return {
    on(event, listener) {
      const wrapped = event === "message" ? data => listener({ data }) : (...args) => listener(...args);
      listeners.set(listener, wrapped); port.on(event, wrapped); return this;
    },
    once(event, listener) {
      const wrapped = event === "message" ? data => listener({ data }) : (...args) => listener(...args);
      listeners.set(listener, wrapped); port.once(event, wrapped); return this;
    },
    off(event, listener) {
      const wrapped = listeners.get(listener) || listener;
      listeners.delete(listener); port.off(event, wrapped); return this;
    },
    postMessage(value, transferList) { port.postMessage(value, transferList); },
    start() { port.start(); },
    close() { port.close(); }
  };
}
const electronParentPort = {
  on(event, listener) {
    const wrapped = value => listener({ ...value, ports: value?.ports?.map(wrapPort) || [] });
    outerListeners.set(listener, wrapped); parentPort.on(event, wrapped); return this;
  },
  once(event, listener) {
    const wrapped = value => listener({ ...value, ports: value?.ports?.map(wrapPort) || [] });
    outerListeners.set(listener, wrapped); parentPort.once(event, wrapped); return this;
  },
  off(event, listener) {
    const wrapped = outerListeners.get(listener) || listener;
    outerListeners.delete(listener); parentPort.off(event, wrapped); return this;
  },
  postMessage(value, transferList) { parentPort.postMessage(value, transferList); }
};
Object.defineProperty(process, "parentPort", { value: electronParentPort, configurable: true });
await import(workerData.hostIndexUrl);
`;

export const HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE = String.raw`
worker.on("message", message => {
  if (
    message?.type !== "browser-execute-request" ||
    typeof message.requestId !== "string" ||
    message.requestId.length === 0
  ) {
    return;
  }
  worker.postMessage({
    data: {
      type: "browser-execute-result",
      requestId: message.requestId,
      result: {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "Browser control is unavailable in zcode-acp headless mode",
          sideEffect: "none"
        },
        elapsedMs: 0
      }
    },
    ports: []
  });
});
`;

export const ZCODE_HOST_BRIDGE_SOURCE = String.raw`
import { MessageChannel, Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const hostIndex = process.env.ZCODE_ACP_HOST_INDEX;
const hostRpcModule = process.env.ZCODE_ACP_HOST_RPC_MODULE;
const hostArtifactJson = process.env.ZCODE_ACP_HOST_ARTIFACT;
const hostProtocolJson = process.env.ZCODE_ACP_HOST_PROTOCOL;
if (!hostIndex || !hostRpcModule || !hostArtifactJson || !hostProtocolJson) {
  throw new Error("Missing ZCode host artifact or protocol");
}
const hostArtifact = JSON.parse(hostArtifactJson);
const hostProtocol = JSON.parse(hostProtocolJson);

const workerSource = ${JSON.stringify(ZCODE_HOST_WORKER_SOURCE)};

const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)), {
  workerData: { hostIndexUrl: pathToFileURL(hostIndex).href },
  stdout: true,
  stderr: true
});
worker.stdout.resume();
worker.stderr.resume();
${HEADLESS_BROWSER_MESSAGE_HANDLER_SOURCE}

const rpc = await import(pathToFileURL(hostRpcModule).href);
const ports = new MessageChannel();
const protocol = new rpc[hostArtifact.rpcExports.protocol](ports.port1);
const client = new rpc[hostArtifact.rpcExports.client](protocol);
const serviceFactory = rpc[hostArtifact.rpcExports.service];
const services = new Map(Object.entries(hostProtocol.serviceChannels).map(([name, channel]) => [
  name,
  serviceFactory.toService(client.getChannel(channel))
]));
const agentService = services.get("agent");
if (!agentService) throw new Error("ZCode host protocol has no agent service");
const subscriptions = new Map();
const commonAgentMethods = new Set([
  "initialize", "readWorkspaceState", "createSession", "resumeSession", "listSessions",
  "readSession", "readSessionMessages", "readSessionEvents", "sendPrompt",
  "closeSession", "setModel", "setThoughtLevel", "setMode", "getTaskTokenUsage",
  "respondProviderRuntimeHeaders", "disposeWorkspace"
]);
const contractOperations = new Set(Object.values(hostProtocol.operations).map(operation =>
  operation.service + ":" + operation.method
));
let shuttingDown = false;

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function dispatch(message) {
  const id = message?.id;
  if (!Number.isInteger(id) && typeof id !== "string") return;
  try {
    if (message.method === "__subscribe") {
      const subscriptionId = message.params?.subscriptionId;
      if (typeof subscriptionId !== "string" || !subscriptionId) throw new Error("Invalid subscription id");
      if (subscriptions.has(subscriptionId)) throw new Error("Duplicate subscription id");
      const disposable = agentService.onDynamicSessionEvent(message.params.target)(event => {
        write({ method: "event", params: { subscriptionId, event } });
      });
      subscriptions.set(subscriptionId, disposable);
      write({ id, result: { subscribed: true } });
      return;
    }
    if (message.method === "__unsubscribe") {
      const disposable = subscriptions.get(message.params?.subscriptionId);
      disposable?.dispose();
      subscriptions.delete(message.params?.subscriptionId);
      write({ id, result: { unsubscribed: true } });
      return;
    }
    if (message.method !== "__call") throw new Error("Unsupported bridge method: " + message.method);
    const serviceName = message.params?.service;
    const nativeMethod = message.params?.method;
    const service = services.get(serviceName);
    if (!service) throw new Error("Unsupported bridge service: " + serviceName);
    const allowed = serviceName === "agent" && commonAgentMethods.has(nativeMethod) ||
      contractOperations.has(serviceName + ":" + nativeMethod);
    if (!allowed) throw new Error("Unsupported native bridge method: " + serviceName + ":" + nativeMethod);
    const result = await service[nativeMethod](message.params?.params);
    write({ id, result: result === undefined ? null : result });
  } catch (error) {
    write({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const disposable of subscriptions.values()) disposable.dispose();
  subscriptions.clear();
  try { worker.postMessage({ data: { type: "dispose" }, ports: [] }); } catch {}
  setTimeout(() => process.exit(0), 2000).unref();
}

worker.on("error", error => {
  if (!shuttingDown) {
    process.stderr.write("ZCode host worker failed: " + error.message + "\n");
    process.exit(1);
  }
});
worker.on("exit", code => {
  if (!shuttingDown) process.exit(code === 0 ? 1 : code);
});

worker.postMessage({
  data: {
    type: "init-local",
    deviceMid: "zcode-acp-headless",
    agentSpawnFallbackCwd: process.cwd()
  },
  ports: [ports.port2]
}, [ports.port2]);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", line => {
  if (!line.trim()) return;
  try { void dispatch(JSON.parse(line)); }
  catch { write({ id: null, error: { code: -32700, message: "Invalid JSON" } }); }
});
lines.on("close", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;
