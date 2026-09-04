import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import {
  NullLogger,
  type LogLevel,
  type Logger,
} from "../../src/diagnostics/logger.ts";
import type { SessionInteraction, SessionUpdate } from "../../src/domain/session-contract.ts";
import {
  HeadlessZCodeSessionEngine,
  MODE_OPTIONS,
} from "../../src/domain/session-service.ts";
import type {
  DynamicEvent,
  SessionSettings,
  SessionSnapshot,
} from "../../src/zcode/protocol/v1/host-schemas.ts";

const OFFICIAL_MODE_OPTIONS = [
  { id: "build", name: "Ask before changes", description: "Ask before each file changes." },
  {
    id: "edit",
    name: "Edit automatically",
    description: "Edit selected files or relevant workspace files automatically.",
  },
  { id: "plan", name: "Plan mode", description: "Inspect the code and present a plan before editing." },
  { id: "yolo", name: "Full access", description: "Edit and run commands with fewer confirmations." },
] as const;

describe("HeadlessZCodeSessionService", () => {
  test("publishes the exact ZCode mode IDs and labels for new and restored sessions", async () => {
    expect(MODE_OPTIONS).toEqual(OFFICIAL_MODE_OPTIONS);
    const harness = await createModeHarness();
    try {
      const created = await harness.service.newSession({
        cwd: harness.workspacePath,
        mcpServers: [],
      });
      expect(created.modes).toEqual({
        currentModeId: "build",
        availableModes: OFFICIAL_MODE_OPTIONS.map((mode) => ({ ...mode })),
      });

      const loaded = await harness.service.loadSession(
        { cwd: harness.workspacePath, sessionId: "session-1", mcpServers: [] },
        harness.interaction,
      );
      expect(loaded.modes).toEqual(created.modes);

      const resumed = await harness.service.resumeSession({
        cwd: harness.workspacePath,
        sessionId: "session-1",
      });
      expect(resumed.modes).toEqual(created.modes);
    } finally {
      await harness.service.close();
    }
  });

  test("passes each published ZCode mode ID to the host unchanged", async () => {
    const harness = await createModeHarness();
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      for (const mode of OFFICIAL_MODE_OPTIONS) {
        harness.updates.length = 0;
        await harness.service.setSessionMode(
          { sessionId: "session-1", modeId: mode.id },
          harness.interaction,
        );
        expect(harness.requests.at(-1)).toEqual({
          method: "setMode",
          params: {
            workspacePath: harness.workspacePath,
            sessionId: "session-1",
            mode: mode.id,
          },
        });
        expect(harness.updates).toEqual([{
          sessionUpdate: "current_mode_update",
          currentModeId: mode.id,
        }]);
      }

      harness.setResponseMode("setMode", "edit");
      harness.updates.length = 0;
      await harness.service.setSessionMode(
        { sessionId: "session-1", modeId: "yolo" },
        harness.interaction,
      );
      expect(harness.requests.at(-1)).toMatchObject({ params: { mode: "yolo" } });
      expect(harness.updates).toEqual([{
        sessionUpdate: "current_mode_update",
        currentModeId: "edit",
      }]);
    } finally {
      await harness.service.close();
    }
  });

  test("rejects any mode outside the published catalog before calling the host", async () => {
    const harness = await createModeHarness();
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      const requestCount = harness.requests.length;
      for (const modeId of ["auto", "future-mode"]) {
        await expect(harness.service.setSessionMode({ sessionId: "session-1", modeId }))
          .rejects.toMatchObject({
            code: "INVALID_CONFIGURATION",
            message: `Unknown ZCode mode: ${modeId}`,
          });
      }
      expect(harness.requests).toHaveLength(requestCount);
    } finally {
      await harness.service.close();
    }
  });

  test("rejects native modes outside the published catalog without changing session state", async () => {
    const invalidCreate = await createModeHarness("future-mode");
    try {
      await expect(invalidCreate.service.newSession({
        cwd: invalidCreate.workspacePath,
        mcpServers: [],
      })).rejects.toMatchObject({
        code: "NATIVE_PROTOCOL_ERROR",
        message: "ZCode returned a mode outside the published catalog: future-mode",
      });
    } finally {
      await invalidCreate.service.close();
    }

    const harness = await createModeHarness();
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });

      harness.setResponseMode("resumeSession", "future-mode");
      await expect(harness.service.resumeSession({
        cwd: harness.workspacePath,
        sessionId: "session-1",
      })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      expect(boundMode(harness.service)).toBe("build");

      harness.setResponseMode("setMode", "future-mode");
      await expect(harness.service.setSessionMode(
        { sessionId: "session-1", modeId: "yolo" },
        harness.interaction,
      )).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      expect(boundMode(harness.service)).toBe("build");
      expect(harness.updates).toHaveLength(0);

      await expect(harness.emitSnapshot("future-mode"))
        .rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      expect(boundMode(harness.service)).toBe("build");
    } finally {
      await harness.service.close();
    }
  });

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

  test("keeps an advertised model selectable after a mode snapshot omits it", async () => {
    const base = testModel("GLM-5.3");
    const flash = testModel("GLM-5.3-Flash", "fast");
    const harness = await createConfigHarness(configSettings({ models: [base, flash] }));
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      harness.setResponseSettings(
        "setMode",
        configSettings({ models: [base], mode: "plan" }),
      );
      await harness.service.setSessionMode({ sessionId: "session-1", modeId: "plan" });

      harness.setResponseSettings(
        "setModel",
        configSettings({ models: [base, flash], currentModel: flash, mode: "plan" }),
      );
      const result = await harness.service.setSessionConfigOption({
        sessionId: "session-1",
        configId: "zcode.model",
        value: testModelValue(flash),
      });

      expect(harness.requests.at(-1)).toEqual({
        method: "setModel",
        params: {
          workspacePath: harness.workspacePath,
          sessionId: "session-1",
          model: flash,
          persistAsWorkspaceLastUsed: true,
        },
      });
      expect(result.configOptions[0]?.currentValue).toBe(testModelValue(flash));
    } finally {
      await harness.service.close();
    }
  });

  test("keeps an advertised model selectable across an unnotified idle snapshot", async () => {
    const base = testModel("GLM-5.3");
    const flash = testModel("GLM-5.3-Flash");
    const harness = await createConfigHarness(configSettings({ models: [base, flash] }));
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      await harness.emitSnapshot(configSettings({ models: [base] }));
      harness.setResponseSettings(
        "setModel",
        configSettings({ models: [base, flash], currentModel: flash }),
      );

      await expect(harness.service.setSessionConfigOption({
        sessionId: "session-1",
        configId: "zcode.model",
        value: testModelValue(flash),
      })).resolves.toBeDefined();
      expect(harness.requests.at(-1)).toMatchObject({
        method: "setModel",
        params: { model: flash },
      });
    } finally {
      await harness.service.close();
    }
  });

  test("replaces advertised model choices only after publishing successful settings", async () => {
    const base = testModel("GLM-5.3");
    const flash = testModel("GLM-5.3-Flash");
    const next = testModel("GLM-5.4");
    const harness = await createConfigHarness(configSettings({ models: [base, flash] }));
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      const requestCount = harness.requests.length;
      for (const value of [testModelValue(next), 42]) {
        await expect(harness.service.setSessionConfigOption({
          sessionId: "session-1",
          configId: "zcode.model",
          value,
        })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
      }
      expect(harness.requests).toHaveLength(requestCount);

      harness.setResponseSettings(
        "setModel",
        configSettings({ models: [base, next], currentModel: base }),
      );
      await harness.service.setSessionConfigOption(
        {
          sessionId: "session-1",
          configId: "zcode.model",
          value: testModelValue(base),
        },
        harness.interaction,
      );
      const published = harness.updates.at(-1);
      expect(published).toMatchObject({ sessionUpdate: "config_option_update" });

      const afterPublishCount = harness.requests.length;
      await expect(harness.service.setSessionConfigOption({
        sessionId: "session-1",
        configId: "zcode.model",
        value: testModelValue(flash),
      })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
      expect(harness.requests).toHaveLength(afterPublishCount);

      harness.setResponseSettings(
        "setModel",
        configSettings({ models: [base, next], currentModel: next }),
      );
      await expect(harness.service.setSessionConfigOption({
        sessionId: "session-1",
        configId: "zcode.model",
        value: testModelValue(next),
      })).resolves.toBeDefined();
      expect(harness.requests.at(-1)).toMatchObject({
        method: "setModel",
        params: { model: next },
      });
    } finally {
      await harness.service.close();
    }
  });

  test("tracks advertised thought levels independently from native snapshots", async () => {
    const model = testModel("GLM-5.3");
    const harness = await createConfigHarness(configSettings({
      models: [model],
      thoughtLevels: ["low", "high"],
      currentThoughtLevel: "low",
    }));
    try {
      await harness.service.newSession({ cwd: harness.workspacePath, mcpServers: [] });
      await harness.emitSnapshot(configSettings({
        models: [model],
        thoughtLevels: ["low"],
        currentThoughtLevel: "low",
      }));
      harness.setResponseSettings(
        "setThoughtLevel",
        configSettings({
          models: [model],
          thoughtLevels: ["low", "medium"],
          currentThoughtLevel: "medium",
        }),
      );
      await harness.service.setSessionConfigOption(
        {
          sessionId: "session-1",
          configId: "zcode.thought_level",
          value: "high",
        },
        harness.interaction,
      );
      expect(harness.requests.at(-1)).toMatchObject({
        method: "setThoughtLevel",
        params: { thoughtLevel: "high" },
      });

      const requestCount = harness.requests.length;
      for (const value of ["high", 42]) {
        await expect(harness.service.setSessionConfigOption({
          sessionId: "session-1",
          configId: "zcode.thought_level",
          value,
        })).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
      }
      expect(harness.requests).toHaveLength(requestCount);

      await expect(harness.service.setSessionConfigOption({
        sessionId: "session-1",
        configId: "zcode.thought_level",
        value: "medium",
      })).resolves.toBeDefined();
      expect(harness.requests.at(-1)).toMatchObject({
        method: "setThoughtLevel",
        params: { thoughtLevel: "medium" },
      });
    } finally {
      await harness.service.close();
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

  test("attributes delayed ACP updates, host acceptance, and the first event to one input", async () => {
    const metadataStarted = Promise.withResolvers<void>();
    const releaseMetadata = Promise.withResolvers<void>();
    const harness = await createToolLifecycleHarness({
      firstMetadataGate: { started: metadataStarted.resolve, wait: releaseMetadata.promise },
    });
    try {
      const prompt = harness.startPrompt();
      await metadataStarted.promise;

      expect(harness.logger.events("acp.session_prompt.started")).toHaveLength(1);
      expect(harness.logger.events("acp.session_update.started")).toHaveLength(1);
      expect(harness.logger.events("acp.session_update.completed")).toHaveLength(0);
      expect(harness.logger.events("zcode.host_request.started")).toHaveLength(0);

      await Bun.sleep(10);
      releaseMetadata.resolve();
      await harness.promptAccepted;
      await Bun.sleep(0);
      expect(harness.logger.events("acp.session_update.completed")).toHaveLength(4);
      expect(harness.logger.events("zcode.host_request.started")).toHaveLength(1);
      expect(harness.logger.events("zcode.host_request.completed")).toHaveLength(1);
      expect(Number(
        harness.logger.events("acp.session_update.completed")[0]?.data.durationMs,
      )).toBeGreaterThanOrEqual(5);

      await Bun.sleep(10);
      await harness.completeTurn();
      await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });

      const firstEvent = harness.logger.events("zcode.event.first_received");
      const completed = harness.logger.events("acp.session_prompt.completed");
      expect(firstEvent).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        level: "info",
        data: {
          outcome: "success",
          stopReason: "end_turn",
        },
      });
      expect(Number(completed[0]?.data.metadataDurationMs)).toBeGreaterThanOrEqual(5);
      expect(Number(completed[0]?.data.firstEventDurationMs)).toBeGreaterThanOrEqual(5);

      const inputIds = harness.logger.records
        .filter((record) => "inputId" in record.data)
        .map((record) => record.data.inputId);
      expect(new Set(inputIds).size).toBe(1);
      expect(JSON.stringify(harness.logger.records)).not.toContain("PROMPT_MUST_NOT_BE_LOGGED");
    } finally {
      await harness.service.close();
    }
  });
});

interface ModeHarness {
  readonly service: HeadlessZCodeSessionEngine;
  readonly workspacePath: string;
  readonly requests: Array<{ method: string; params: unknown }>;
  readonly updates: SessionUpdate[];
  readonly interaction: SessionInteraction;
  setResponseMode(method: string, mode: string): void;
  emitSnapshot(mode: string): Promise<void>;
}

async function createModeHarness(createMode = "build"): Promise<ModeHarness> {
  const workspacePath = await realpath(process.cwd());
  const requests: Array<{ method: string; params: unknown }> = [];
  const updates: SessionUpdate[] = [];
  const responseModes = new Map<string, string>();
  let currentMode = "build";
  let subscription: ((event: DynamicEvent) => Promise<void> | void) | undefined;

  const snapshot = (mode: string): SessionSnapshot => ({
    session: {
      sessionId: "session-1",
      status: "idle",
      workspace: { workspacePath },
    },
    settings: modeSettings(mode),
    messages: [],
    runtime: {},
    slashCommands: [],
  });
  const bridge = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "initialize") return { available: true };
      if (method === "readWorkspaceState") {
        return {
          workspace: { workspacePath },
          settings: modeSettings(currentMode),
          modelCatalog: { providers: [{}], available: [] },
        };
      }
      if (method === "createSession") return snapshot(createMode);
      if (method === "resumeSession" || method === "readSession") {
        return snapshot(responseModes.get(method) ?? currentMode);
      }
      if (method === "setMode") {
        const requested = (params as { mode: string }).mode;
        const returned = responseModes.get(method) ?? requested;
        if (returned === requested) currentMode = requested;
        return snapshot(returned);
      }
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
  const interaction: SessionInteraction = {
    planOperationsSupported: false,
    async notify(_sessionId, update) {
      updates.push(update);
    },
    async requestPermission() {
      return null;
    },
    async requestPlanApproval() {
      return { action: "decline" };
    },
    async requestUserInput() {
      return { action: "decline" };
    },
  };

  return {
    service,
    workspacePath,
    requests,
    updates,
    interaction,
    setResponseMode(method, mode) {
      responseModes.set(method, mode);
    },
    async emitSnapshot(mode) {
      if (subscription === undefined) throw new Error("Subscription was not established");
      await subscription({ type: "snapshot", snapshot: snapshot(mode) });
    },
  };
}

function modeSettings(mode: string): SessionSettings {
  return {
    model: {
      current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
      available: [],
    },
    thoughtLevel: { enabled: false, available: [] },
    mode: { current: mode },
  };
}

function boundMode(service: HeadlessZCodeSessionEngine): string | undefined {
  const sessions = Reflect.get(service, "sessions") as Map<
    string,
    { settings: SessionSettings }
  >;
  return sessions.get("session-1")?.settings.mode.current;
}

interface TestModelRef {
  readonly [key: string]: unknown;
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
}

interface ConfigHarness {
  readonly service: HeadlessZCodeSessionEngine;
  readonly workspacePath: string;
  readonly requests: Array<{ method: string; params: unknown }>;
  readonly updates: SessionUpdate[];
  readonly interaction: SessionInteraction;
  setResponseSettings(method: string, settings: SessionSettings): void;
  emitSnapshot(settings: SessionSettings): Promise<void>;
}

async function createConfigHarness(initialSettings: SessionSettings): Promise<ConfigHarness> {
  const workspacePath = await realpath(process.cwd());
  const requests: Array<{ method: string; params: unknown }> = [];
  const updates: SessionUpdate[] = [];
  const responseSettings = new Map<string, SessionSettings>();
  let currentSettings = initialSettings;
  let subscription: ((event: DynamicEvent) => Promise<void> | void) | undefined;

  const snapshot = (settings: SessionSettings): SessionSnapshot => ({
    session: {
      sessionId: "session-1",
      status: "idle",
      workspace: { workspacePath },
    },
    settings,
    messages: [],
    runtime: {},
    slashCommands: [],
  });
  const bridge = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "initialize") return { available: true };
      if (method === "readWorkspaceState") {
        return {
          workspace: { workspacePath },
          settings: currentSettings,
          modelCatalog: { providers: [{}], available: [] },
        };
      }
      if (method === "createSession") return snapshot(currentSettings);
      if (method === "resumeSession" || method === "readSession") {
        currentSettings = responseSettings.get(method) ?? currentSettings;
        return snapshot(currentSettings);
      }
      if (method === "setMode" || method === "setModel" || method === "setThoughtLevel") {
        currentSettings = responseSettings.get(method) ?? currentSettings;
        return snapshot(currentSettings);
      }
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
  const interaction: SessionInteraction = {
    planOperationsSupported: false,
    async notify(_sessionId, update) {
      updates.push(update);
    },
    async requestPermission() {
      return null;
    },
    async requestPlanApproval() {
      return { action: "decline" };
    },
    async requestUserInput() {
      return { action: "decline" };
    },
  };

  return {
    service,
    workspacePath,
    requests,
    updates,
    interaction,
    setResponseSettings(method, settings) {
      responseSettings.set(method, settings);
    },
    async emitSnapshot(settings) {
      if (subscription === undefined) throw new Error("Subscription was not established");
      currentSettings = settings;
      await subscription({ type: "snapshot", snapshot: snapshot(settings) });
    },
  };
}

function testModel(modelId: string, variant?: string): TestModelRef {
  return {
    providerId: "builtin:zai-coding-plan",
    modelId,
    ...(variant === undefined ? {} : { variant }),
  };
}

function testModelValue(model: TestModelRef): string {
  return JSON.stringify([model.providerId, model.modelId, model.variant ?? null]);
}

function configSettings(options: {
  readonly models: readonly TestModelRef[];
  readonly currentModel?: TestModelRef;
  readonly mode?: string;
  readonly thoughtLevels?: readonly string[];
  readonly currentThoughtLevel?: string;
}): SessionSettings {
  const currentModel = options.currentModel ?? options.models[0];
  if (currentModel === undefined) throw new Error("A current model is required");
  const thoughtLevels = options.thoughtLevels ?? [];
  return {
    model: {
      current: currentModel,
      available: options.models.map((ref) => ({ ref, label: ref.modelId })),
    },
    thoughtLevel: {
      enabled: thoughtLevels.length > 0,
      ...(options.currentThoughtLevel === undefined
        ? {}
        : { current: options.currentThoughtLevel }),
      available: thoughtLevels.map((value) => ({ value, label: value })),
    },
    mode: { current: options.mode ?? "build" },
  };
}

interface ToolLifecycleHarness {
  readonly service: HeadlessZCodeSessionEngine;
  readonly updates: SessionUpdate[];
  readonly requests: string[];
  readonly promptAccepted: Promise<void>;
  readonly logger: CaptureLogger;
  startPrompt(): Promise<unknown>;
  emitTool(kind: string, payload?: Record<string, unknown>): Promise<void>;
  completeTurn(): Promise<void>;
}

async function createToolLifecycleHarness(options: {
  firstMetadataGate?: { readonly started: () => void; readonly wait: Promise<void> };
} = {}): Promise<ToolLifecycleHarness> {
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
  const logger = new CaptureLogger();
  const service = new HeadlessZCodeSessionEngine(logger);
  Reflect.set(service, "bridgePromise", Promise.resolve(bridge));
  await service.newSession({ cwd: workspacePath, mcpServers: [] });
  const updates: SessionUpdate[] = [];
  let firstMetadataNotification = true;
  const interaction: SessionInteraction = {
    planOperationsSupported: false,
    async notify(_sessionId, update) {
      updates.push(update);
      if (firstMetadataNotification && options.firstMetadataGate !== undefined) {
        firstMetadataNotification = false;
        options.firstMetadataGate.started();
        await options.firstMetadataGate.wait;
      }
    },
    async requestPermission() {
      return null;
    },
    async requestPlanApproval() {
      return { action: "decline" };
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
    logger,
    promptAccepted: promptAccepted.promise,
    startPrompt: () => service.prompt(
      {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "PROMPT_MUST_NOT_BE_LOGGED" }],
      },
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

class CaptureLogger implements Logger {
  readonly records: Array<{ level: LogLevel; event: string; data: Record<string, unknown> }> = [];

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    this.records.push({ level, event, data });
  }

  error(event: string, error: unknown, data: Record<string, unknown> = {}): void {
    this.log("error", event, { ...data, error });
  }

  events(event: string): typeof this.records {
    return this.records.filter((record) => record.event === event);
  }
}
