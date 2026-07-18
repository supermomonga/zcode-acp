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

export const ZCODE_HOST_BRIDGE_SOURCE = String.raw`
import { MessageChannel, Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const hostIndex = process.env.ZCODE_ACP_HOST_INDEX;
const hostRpcModule = process.env.ZCODE_ACP_HOST_RPC_MODULE;
if (!hostIndex || !hostRpcModule) throw new Error("Missing ZCode host module paths");

const workerSource = ${JSON.stringify(ZCODE_HOST_WORKER_SOURCE)};

const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(workerSource)), {
  workerData: { hostIndexUrl: pathToFileURL(hostIndex).href },
  stdout: true,
  stderr: true
});
worker.stdout.resume();
worker.stderr.resume();

const rpc = await import(pathToFileURL(hostRpcModule).href);
const ports = new MessageChannel();
const protocol = new rpc.g(ports.port1);
const client = new rpc.i(protocol);
const service = rpc.j.toService(client.getChannel("zcode-agent"));
const subscriptions = new Map();
const allowed = new Set([
  "initialize", "readWorkspaceState", "createSession", "resumeSession", "listSessions",
  "readSession", "readSessionMessages", "readSessionEvents", "sendPrompt", "stopSession",
  "closeSession", "setModel", "setThoughtLevel", "setMode", "respondPermission",
  "getTaskTokenUsage", "respondUserInput", "respondProviderRuntimeHeaders", "disposeWorkspace"
]);
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
      const disposable = service.onDynamicSessionEvent(message.params.target)(event => {
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
    if (!allowed.has(message.method)) throw new Error("Unsupported bridge method: " + message.method);
    const result = await service[message.method](message.params);
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
