import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import type { SessionInteraction, SessionUpdate } from "../../src/domain/session-contract.ts";
import { HeadlessZCodeSessionEngine } from "../../src/domain/session-service.ts";
import type {
  DynamicEvent,
  SessionSettings,
  SessionSnapshot,
} from "../../src/zcode/protocol/v1/host-schemas.ts";

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
    const service = new HeadlessZCodeSessionEngine(new NullLogger());
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

  test("maps repeated native progress to one in-progress update", async () => {
    const harness = await createToolLifecycleHarness();
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitTool("scheduled");
      await harness.emitTool("started");
      await harness.emitTool("progress", progressPayload());
      await harness.emitTool("progress", progressPayload());
      await harness.emitTool("result", { result: { content: "done" } });
      await harness.completeTurn();

      await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(toolUpdates(harness.updates)).toEqual([
        expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          status: "pending",
        }),
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "in_progress",
        },
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { content: "done" },
        }),
      ]);
    } finally {
      await harness.service.close();
    }
  });

  test("promotes progress-first tools and preserves a later error", async () => {
    const harness = await createToolLifecycleHarness();
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitTool("progress", progressPayload());
      await harness.emitTool("error", { error: { message: "failed" } });
      await harness.completeTurn();

      await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(toolUpdates(harness.updates)).toEqual([
        expect.objectContaining({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          status: "pending",
        }),
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "in_progress",
        },
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "failed",
          rawOutput: { message: "failed" },
        }),
      ]);
    } finally {
      await harness.service.close();
    }
  });

  test("rejects progress after a terminal tool update", async () => {
    for (const terminal of [
      { kind: "result", payload: { result: { content: "done" } }, status: "completed" },
      { kind: "error", payload: { error: { message: "failed" } }, status: "failed" },
    ]) {
      const harness = await createToolLifecycleHarness();
      try {
        const prompt = harness.startPrompt();
        await harness.promptAccepted;
        await harness.emitTool("progress", progressPayload());
        await harness.emitTool(terminal.kind, terminal.payload);
        await harness.emitTool("progress", progressPayload());

        await expect(prompt).rejects.toMatchObject({
          code: "NATIVE_PROTOCOL_ERROR",
          message: `Invalid tool transition: progress after ${terminal.status}`,
        });
        for (
          let attempt = 0;
          attempt < 10 && !harness.requests.includes("cancelGeneration");
          attempt += 1
        ) {
          await Bun.sleep(0);
        }
        expect(harness.requests).toContain("cancelGeneration");
      } finally {
        await harness.service.close();
      }
    }
  });
});

interface ToolLifecycleHarness {
  readonly service: HeadlessZCodeSessionEngine;
  readonly updates: SessionUpdate[];
  readonly requests: string[];
  readonly promptAccepted: Promise<void>;
  startPrompt(): Promise<unknown>;
  emitTool(kind: string, payload?: Record<string, unknown>): Promise<void>;
  completeTurn(): Promise<void>;
}

async function createToolLifecycleHarness(): Promise<ToolLifecycleHarness> {
  const workspacePath = await realpath(process.cwd());
  const settings = lifecycleSettings();
  const snapshot: SessionSnapshot = {
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
  const promptAccepted = Promise.withResolvers<void>();
  const requests: string[] = [];
  let subscription: ((event: DynamicEvent) => Promise<void> | void) | undefined;
  let sequence = 0;
  const bridge = {
    async request(method: string) {
      requests.push(method);
      if (method === "initialize") return { available: true };
      if (method === "readWorkspaceState") {
        return {
          workspace: { workspacePath },
          settings,
          modelCatalog: { providers: [{}], available: [] },
        };
      }
      if (method === "createSession" || method === "readSession") return snapshot;
      if (method === "sendPrompt") {
        promptAccepted.resolve();
        return { sessionId: "session-1", accepted: true };
      }
      if (method === "getTaskTokenUsage") {
        return {
          sessionId: "session-1",
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
      }
      if (method === "cancelGeneration") return null;
      throw new Error(`Unexpected request: ${method}`);
    },
    async subscribe(
      _target: unknown,
      handler: (event: DynamicEvent) => Promise<void> | void,
    ) {
      subscription = handler;
      return { async dispose() {} };
    },
    async close() {},
  };
  const service = new HeadlessZCodeSessionEngine(new NullLogger());
  Reflect.set(service, "bridgePromise", Promise.resolve(bridge));
  await service.newSession({ cwd: workspacePath, mcpServers: [] });
  const updates: SessionUpdate[] = [];
  const interaction: SessionInteraction = {
    async notify(_sessionId, update) {
      updates.push(update);
    },
    async requestPermission() {
      return null;
    },
    async requestUserInput() {
      return { action: "decline" };
    },
  };

  const emit = async (type: string, payload: Record<string, unknown>) => {
    if (subscription === undefined) throw new Error("Subscription was not established");
    sequence += 1;
    await subscription({
      type: "session.event",
      event: {
        eventId: `event-${sequence}`,
        sessionId: "session-1",
        turnId: "turn-1",
        seq: sequence,
        timestamp: Date.now(),
        deliveryKind: "desktop-continuous",
        type,
        payload,
      },
    });
  };

  return {
    service,
    updates,
    requests,
    promptAccepted: promptAccepted.promise,
    startPrompt: () => service.prompt(
      { sessionId: "session-1", prompt: [{ type: "text", text: "run" }] },
      interaction,
      new AbortController().signal,
    ),
    emitTool: (kind, payload = {}) => emit("tool.updated", {
      kind,
      toolCallId: "tool-1",
      toolName: "Bash",
      ...payload,
    }),
    completeTurn: () => emit("turn.completed", { resultType: "success" }),
  };
}

function lifecycleSettings(): SessionSettings {
  return {
    model: {
      current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
      available: [],
    },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: "build" },
  };
}

function progressPayload(): Record<string, unknown> {
  return {
    elapsedMs: 1_500,
    pid: 42,
    stdoutBytes: 120,
    stderrBytes: 5,
    outputBytes: 125,
    stdoutTail: "partial output",
    stderrTail: "warning",
  };
}

function toolUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  return updates.filter((update) =>
    update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
  );
}
