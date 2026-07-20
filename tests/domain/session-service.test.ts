import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import { HeadlessZCodeSessionService } from "../../src/domain/session-service.ts";

describe("HeadlessZCodeSessionService", () => {
  test("uses model IDs for ACP display names like the official ZCode GUI", async () => {
    const workspacePath = await realpath(process.cwd());
    const settings = {
      model: {
        current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
        available: [
          {
            ref: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
            label: "GLM-5.2",
            providerLabel: "Z.ai - Coding Plan",
          },
          {
            ref: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5-Turbo" },
            label: "glm-5-turbo",
            providerLabel: "Z.ai - Coding Plan",
          },
        ],
      },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    };
    const snapshot = {
      session: {
        sessionId: "session-1",
        status: "idle",
        workspace: { workspacePath },
      },
      settings,
      messages: [],
      runtime: {},
      slashCommands: [],
    };
    const bridge = {
      async request(method: string) {
        if (method === "initialize") {
          return { available: true };
        }
        if (method === "readWorkspaceState") {
          return {
            workspace: { workspacePath },
            settings,
            modelCatalog: { providers: [{}], available: [] },
          };
        }
        if (method === "createSession") {
          return snapshot;
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      async subscribe() {
        return { async dispose() {} };
      },
      async close() {},
    };
    const service = new HeadlessZCodeSessionService(new NullLogger());
    Reflect.set(service, "bridgePromise", Promise.resolve(bridge));

    try {
      const response = await service.newSession({ cwd: workspacePath, mcpServers: [] });

      expect(response.configOptions?.[0]).toEqual({
        id: "zcode.model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: '["builtin:zai-coding-plan","GLM-5.2",null]',
        options: [
          {
            value: '["builtin:zai-coding-plan","GLM-5.2",null]',
            name: "GLM-5.2",
            description: "Z.ai - Coding Plan",
          },
          {
            value: '["builtin:zai-coding-plan","GLM-5-Turbo",null]',
            name: "GLM-5-Turbo",
            description: "Z.ai - Coding Plan",
          },
        ],
      });
    } finally {
      await service.close();
    }
  });
});
