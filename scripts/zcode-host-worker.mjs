import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) {
  throw new Error("ZCode host worker requires a worker_threads parent port");
}

const listenerMap = new Map();

const wrapTransferredPort = (port) => {
  const portListeners = new Map();
  return {
    on(event, listener) {
      const wrapped = event === "message"
        ? (data) => listener({ data })
        : (...args) => listener(...args);
      portListeners.set(listener, wrapped);
      port.on(event, wrapped);
      return this;
    },
    once(event, listener) {
      const wrapped = event === "message"
        ? (data) => listener({ data })
        : (...args) => listener(...args);
      portListeners.set(listener, wrapped);
      port.once(event, wrapped);
      return this;
    },
    off(event, listener) {
      const wrapped = portListeners.get(listener) ?? listener;
      portListeners.delete(listener);
      port.off(event, wrapped);
      return this;
    },
    postMessage(value, transferList) {
      port.postMessage(value, transferList);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
};

const electronParentPort = {
  on(event, listener) {
    const wrapped = (value) => listener({
      ...value,
      ports: value?.ports?.map(wrapTransferredPort) ?? [],
    });
    listenerMap.set(listener, wrapped);
    parentPort.on(event, wrapped);
    return electronParentPort;
  },
  once(event, listener) {
    const wrapped = (value) => listener({
      ...value,
      ports: value?.ports?.map(wrapTransferredPort) ?? [],
    });
    listenerMap.set(listener, wrapped);
    parentPort.once(event, wrapped);
    return electronParentPort;
  },
  off(event, listener) {
    const wrapped = listenerMap.get(listener) ?? listener;
    listenerMap.delete(listener);
    parentPort.off(event, wrapped);
    return electronParentPort;
  },
  postMessage(value, transferList) {
    parentPort.postMessage(value, transferList);
  },
};

Object.defineProperty(process, "parentPort", {
  configurable: true,
  enumerable: false,
  value: electronParentPort,
  writable: false,
});

await import(workerData.hostIndexUrl);
