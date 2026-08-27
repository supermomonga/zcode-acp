import { describe, expect, test } from "bun:test";
import { AdapterError } from "../../src/domain/errors.ts";
import {
  hostContractMismatch,
  resolveHostContractPaths,
} from "../../src/zcode/discovery/host-contract.ts";
import type { HostContractDescriptor } from "../../src/zcode/discovery/types.ts";
import { adaptHostRequest } from "../../src/zcode/host/contract.ts";

const legacy: HostContractDescriptor = {
  id: "zcode-host-3.3.6",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-HAEWO5CB.js",
  rpcExports: { protocol: "g", client: "i", service: "j" },
  serviceChannels: { agent: "zcode-agent" },
  operations: {
    cancelGeneration: { method: "stopSession", service: "agent", sessionParameter: "sessionId" },
    respondStructuredInput: {
      method: "respondUserInput",
      service: "agent",
      sessionParameter: "sessionId",
      responseShape: "nested",
    },
    respondPermission: {
      method: "respondPermission",
      service: "agent",
      sessionParameter: "sessionId",
      answerShape: "response",
    },
  },
};

const current: HostContractDescriptor = {
  id: "zcode-host-3.9.2",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-KGXW6KHC.js",
  hostIndexSha256: "a".repeat(64),
  hostRpcModuleSha256: "b".repeat(64),
  rpcExports: { protocol: "g", client: "i", service: "j" },
  serviceChannels: { agent: "zcode-agent", task: "zcode-task" },
  operations: {
    cancelGeneration: { method: "stopGeneration", service: "task", sessionParameter: "taskId" },
    respondStructuredInput: {
      method: "respondElicitation",
      service: "task",
      sessionParameter: "taskId",
      responseShape: "flattened",
    },
    respondPermission: {
      method: "respondPermission",
      service: "task",
      sessionParameter: "taskId",
      answerShape: "optionId",
    },
  },
};

describe("ZCode host contract", () => {
  test("maps legacy interaction operations without losing the semantic response", () => {
    expect(adaptHostRequest(legacy, "cancelGeneration", { sessionId: "s", workspacePath: "/w" }))
      .toEqual({ service: "agent", method: "stopSession", params: { sessionId: "s", workspacePath: "/w" } });
    expect(adaptHostRequest(legacy, "respondStructuredInput", {
      sessionId: "s",
      requestId: "r",
      response: { action: "accept", content: { answer: "yes" } },
    })).toEqual({
      service: "agent",
      method: "respondUserInput",
      params: {
        sessionId: "s",
        requestId: "r",
        response: { action: "accept", content: { answer: "yes" } },
      },
    });
    expect(adaptHostRequest(legacy, "respondPermission", {
      sessionId: "s",
      requestId: "r",
      optionId: "deny",
      response: { decision: "deny" },
    })).toEqual({
      service: "agent",
      method: "respondPermission",
      params: { sessionId: "s", requestId: "r", response: { decision: "deny" } },
    });
  });

  test("maps ZCode 3.9.2 task interactions to the native task contract", () => {
    expect(adaptHostRequest(current, "cancelGeneration", { sessionId: "s", workspacePath: "/w" }))
      .toEqual({ service: "task", method: "stopGeneration", params: { taskId: "s", workspacePath: "/w" } });
    expect(adaptHostRequest(current, "respondStructuredInput", {
      sessionId: "s",
      requestId: "r",
      response: { action: "accept", content: { answer: "yes" } },
    })).toEqual({
      service: "task",
      method: "respondElicitation",
      params: { taskId: "s", requestId: "r", action: "accept", content: { answer: "yes" } },
    });
    expect(adaptHostRequest(current, "respondPermission", {
      sessionId: "s",
      requestId: "r",
      optionId: "allow-once",
      response: { decision: "allow" },
    })).toEqual({
      service: "task",
      method: "respondPermission",
      params: { taskId: "s", requestId: "r", optionId: "allow-once" },
    });
  });

  test("rejects missing 3.9.2 permission option IDs", () => {
    expect(() => adaptHostRequest(current, "respondPermission", {
      sessionId: "s",
      requestId: "r",
      response: { decision: "deny" },
    })).toThrow(AdapterError);
  });

  test("rejects host paths that escape the install root", () => {
    expect(() => resolveHostContractPaths("/Applications/ZCode.app", "/Applications/ZCode.app/app.asar", {
      ...current,
      hostRpcModuleRelativePath: "../../../outside.js",
    })).toThrow("outside the install root");
  });

  test("rejects host hashes and required RPC exports independently", () => {
    const valid = {
      hostIndexSha256: "a".repeat(64),
      hostRpcModuleSha256: "b".repeat(64),
      exports: ["g", "i", "j"],
    };
    expect(hostContractMismatch(current, valid)).toBeUndefined();
    expect(hostContractMismatch(current, { ...valid, hostIndexSha256: "c".repeat(64) }))
      .toBe("ZCode host index hash does not match the compatibility manifest");
    expect(hostContractMismatch(current, { ...valid, hostRpcModuleSha256: "c".repeat(64) }))
      .toBe("ZCode host RPC module hash does not match the compatibility manifest");
    expect(hostContractMismatch(current, { ...valid, exports: ["g", "i"] }))
      .toBe("ZCode host RPC module is missing required export: j");
  });

  test("rejects an operation whose service channel is not declared", () => {
    const descriptor = structuredClone(current);
    delete (descriptor.serviceChannels as { task?: string }).task;
    expect(hostContractMismatch(descriptor, {
      hostIndexSha256: "a".repeat(64),
      hostRpcModuleSha256: "b".repeat(64),
      exports: ["g", "i", "j"],
    })).toBe(
      "ZCode host contract operation cancelGeneration references an unavailable service: task",
    );
  });
});
