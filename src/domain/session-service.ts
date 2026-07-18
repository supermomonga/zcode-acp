import type * as acp from "@agentclientprotocol/sdk";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../diagnostics/logger.ts";
import { AdapterError } from "./errors.ts";
import { resolveWorkspace } from "./workspace.ts";
import {
  assertRuntimeSupported,
  discoverRuntime,
  runBundledCliCommand,
  runRuntimeSmoke,
} from "../zcode/discovery/discover.ts";
import type { DiscoveryOptions } from "../zcode/discovery/discover.ts";
import { ZCodeHostBridge, type HostSubscription } from "../zcode/host/bridge.ts";
import {
  InitializeResultSchema,
  SendPromptResultSchema,
  SessionListSchema,
  SessionSnapshotSchema,
  TokenUsageSchema,
  UnknownResultSchema,
  WorkspaceStateResultSchema,
  type DynamicEvent,
  type PermissionRequest,
  type PermissionResponse,
  type SessionEvent,
  type SessionSettings,
  type SessionSnapshot,
  type UserInputRequest,
} from "../zcode/protocol/v1/host-schemas.ts";

export interface SessionService {
  initialize(params: acp.InitializeRequest): Promise<void>;
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>;
  loadSession(
    params: acp.LoadSessionRequest,
    context: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse>;
  resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse>;
  listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse>;
  closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse>;
  setSessionMode(
    params: acp.SetSessionModeRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionModeResponse>;
  setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionConfigOptionResponse>;
  authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse>;
  logout(params: acp.LogoutRequest): Promise<acp.LogoutResponse>;
  prompt(
    params: acp.PromptRequest,
    context: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<acp.PromptResponse>;
  cancel(params: acp.CancelNotification): Promise<void>;
  close(): Promise<void>;
}

interface ToolState {
  readonly id: string;
  name: string;
  rawInputText: string;
  created: boolean;
}

interface ActiveTurn {
  readonly context: acp.AgentContext;
  readonly resolve: (response: acp.PromptResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly tools: Map<string, ToolState>;
  cancelled: boolean;
  settled: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
}

interface SessionBinding {
  readonly sessionId: string;
  readonly workspacePath: string;
  subscription: HostSubscription;
  settings: SessionSettings;
  snapshot: SessionSnapshot;
  active?: ActiveTurn;
}

const MODE_OPTIONS: acp.SessionMode[] = [
  { id: "build", name: "Build", description: "標準の確認付き実装モード" },
  { id: "edit", name: "Edit", description: "編集中心の権限制御モード" },
  { id: "plan", name: "Plan", description: "読み取りと計画を中心にしたモード" },
  { id: "auto", name: "Auto", description: "ZCodeが操作ごとに権限処理を選択するモード" },
  { id: "yolo", name: "YOLO", description: "高権限モード。ツール操作を自動承認します" },
];

const MODEL_CONFIG_ID = "zcode.model";
const THOUGHT_CONFIG_ID = "zcode.thought_level";
const AUTH_METHOD_ID = "zcode-cli";

const IgnoredSessionEvents = new Set([
  "session.updated",
  "streamRecovery.updated",
  "turn.started",
  "permission.requested",
  "permission.resolved",
  "checkpoint.created",
]);

export class HeadlessZCodeSessionService implements SessionService {
  private readonly sessions = new Map<string, SessionBinding>();
  private bridgePromise: Promise<ZCodeHostBridge> | undefined;
  private formElicitationSupported = false;

  constructor(
    private readonly logger: Logger,
    private readonly discoveryOptions: DiscoveryOptions = {},
  ) {}

  async initialize(params: acp.InitializeRequest): Promise<void> {
    this.formElicitationSupported = params.clientCapabilities?.elicitation?.form != null;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    assertNoAdditionalDirectories(params.additionalDirectories);
    const workspace = await resolveWorkspace(params.cwd);
    const bridge = await this.getBridge();
    await this.initializeWorkspace(workspace.cwd);

    const snapshot = await bridge.request(
      "createSession",
      {
        workspacePath: workspace.cwd,
        persistence: "immediate",
        mcpServers: params.mcpServers,
      },
      SessionSnapshotSchema,
      60_000,
    );
    await this.bindSnapshot(workspace.cwd, snapshot);
    return sessionSetupResponse(snapshot);
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    context: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    assertNoAdditionalDirectories(params.additionalDirectories);
    const snapshot = await this.resumeSnapshot(params.cwd, params.sessionId, params.mcpServers);
    for (const message of snapshot.messages) {
      for (const part of message.parts) {
        const text = stringValue(part.text);
        if (text !== undefined && (part.type === "text" || part.type === "reasoning")) {
          await context.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: message.info.role === "user"
                ? "user_message_chunk"
                : part.type === "reasoning"
                  ? "agent_thought_chunk"
                  : "agent_message_chunk",
              content: { type: "text", text },
              messageId: message.info.messageId,
            },
          });
          continue;
        }
        if (part.type === "file") {
          const uri = stringValue(part.url);
          if (uri === undefined) continue;
          await context.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: message.info.role === "user"
                ? "user_message_chunk"
                : "agent_message_chunk",
              content: {
                type: "resource_link",
                name: stringValue(part.filename) ?? "file",
                uri,
                ...(stringValue(part.mime) === undefined ? {} : { mimeType: stringValue(part.mime)! }),
              },
              messageId: message.info.messageId,
            },
          });
          continue;
        }
        if (part.type === "tool") {
          const toolCallId = stringValue(part.callId);
          const name = stringValue(part.tool);
          const state = asRecord(part.state);
          if (toolCallId === undefined || name === undefined) {
            throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Persisted tool part is malformed");
          }
          const status = persistedToolStatus(stringValue(state.status));
          const output = state.output ?? state.error;
          await context.notify("session/update", {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: stringValue(state.title) ?? name,
              kind: toolKind(name),
              status,
              rawInput: state.input,
              ...(output === undefined ? {} : { rawOutput: output, content: textToolContent(output) }),
            },
          });
        }
      }
    }
    await this.notifySessionMetadata(context, params.sessionId, snapshot);
    return sessionState(snapshot);
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    assertNoAdditionalDirectories(params.additionalDirectories);
    const snapshot = await this.resumeSnapshot(params.cwd, params.sessionId, params.mcpServers ?? []);
    return sessionState(snapshot);
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    if (params.cwd == null) {
      throw new AdapterError(
        "INVALID_CONFIGURATION",
        "ZCode requires cwd when listing sessions",
      );
    }
    if (params.cursor != null) {
      throw new AdapterError("INVALID_CONFIGURATION", "ZCode session listing is not paginated");
    }
    const workspace = await resolveWorkspace(params.cwd);
    await this.initializeWorkspace(workspace.cwd);
    const sessions = await (await this.getBridge()).request(
      "listSessions",
      { workspacePath: workspace.cwd, includeArchived: false },
      SessionListSchema,
      60_000,
    );
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.workspace.workspacePath,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.updatedAt === undefined
          ? {}
          : { updatedAt: new Date(session.updatedAt).toISOString() }),
      })),
    };
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    const binding = this.sessions.get(params.sessionId);
    if (binding === undefined) return {};
    if (binding.active !== undefined) await this.cancel({ sessionId: params.sessionId });
    await (await this.getBridge()).request(
      "closeSession",
      { workspacePath: binding.workspacePath, sessionId: binding.sessionId },
      UnknownResultSchema,
    );
    await binding.subscription.dispose();
    this.sessions.delete(params.sessionId);
    return {};
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionModeResponse> {
    if (!MODE_OPTIONS.some((mode) => mode.id === params.modeId)) {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown ZCode mode: ${params.modeId}`);
    }
    const binding = this.requireSession(params.sessionId);
    const snapshot = await (await this.getBridge()).request(
      "setMode",
      { workspacePath: binding.workspacePath, sessionId: binding.sessionId, mode: params.modeId },
      SessionSnapshotSchema,
      60_000,
    );
    binding.settings = snapshot.settings;
    binding.snapshot = snapshot;
    if (context !== undefined) {
      await context.notify("session/update", {
        sessionId: binding.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
      });
    }
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const binding = this.requireSession(params.sessionId);
    if (params.configId === MODEL_CONFIG_ID && !("type" in params)) {
      const selected = binding.settings.model.available.find(
        (option) => modelValue(option.ref) === params.value,
      );
      if (selected === undefined) {
        throw new AdapterError("INVALID_CONFIGURATION", `Unknown ZCode model: ${params.value}`);
      }
      const snapshot = await (await this.getBridge()).request(
        "setModel",
        {
          workspacePath: binding.workspacePath,
          sessionId: binding.sessionId,
          model: selected.ref,
          persistAsWorkspaceLastUsed: true,
        },
        SessionSnapshotSchema,
        60_000,
      );
      binding.settings = snapshot.settings;
      binding.snapshot = snapshot;
    } else if (params.configId === THOUGHT_CONFIG_ID && !("type" in params)) {
      if (!binding.settings.thoughtLevel.available.some((option) => option.value === params.value)) {
        throw new AdapterError("INVALID_CONFIGURATION", `Unknown thought level: ${params.value}`);
      }
      const snapshot = await (await this.getBridge()).request(
        "setThoughtLevel",
        {
          workspacePath: binding.workspacePath,
          sessionId: binding.sessionId,
          thoughtLevel: params.value,
          persistAsWorkspaceLastUsed: true,
        },
        SessionSnapshotSchema,
        60_000,
      );
      binding.settings = snapshot.settings;
      binding.snapshot = snapshot;
    } else {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown config option: ${params.configId}`);
    }
    const options = configOptions(binding.settings);
    if (context !== undefined) {
      await context.notify("session/update", {
        sessionId: binding.sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: options },
      });
    }
    return { configOptions: options };
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== AUTH_METHOD_ID) {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown auth method: ${params.methodId}`);
    }
    const runtime = await discoverRuntime(this.discoveryOptions);
    const smoke = await runRuntimeSmoke(
      runtime,
      this.discoveryOptions.environment ?? process.env,
    );
    if (smoke.authentication !== "present") {
      throw new AdapterError("AUTH_REQUIRED", "ZCode login has not completed");
    }
    return {};
  }

  async logout(_params: acp.LogoutRequest): Promise<acp.LogoutResponse> {
    const runtime = await discoverRuntime(this.discoveryOptions);
    assertRuntimeSupported(runtime);
    const result = await runBundledCliCommand(
      runtime.paths,
      ["logout"],
      this.discoveryOptions.environment ?? process.env,
    );
    if (result.exitCode !== 0) {
      throw new AdapterError("NATIVE_PROTOCOL_ERROR", "ZCode logout failed");
    }
    return {};
  }

  async prompt(
    params: acp.PromptRequest,
    context: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    const binding = this.sessions.get(params.sessionId);
    if (binding === undefined) {
      throw new AdapterError("SESSION_NOT_FOUND", `Unknown session: ${params.sessionId}`);
    }
    if (binding.active !== undefined) {
      throw new AdapterError("SESSION_BUSY", "A prompt is already active for this session");
    }

    const prompt = nativePrompt(params.prompt);
    const completion = Promise.withResolvers<acp.PromptResponse>();
    const turn: ActiveTurn = {
      context,
      resolve: completion.resolve,
      reject: completion.reject,
      tools: new Map(),
      cancelled: false,
      settled: false,
    };
    binding.active = turn;
    const abort = () => void this.cancel({ sessionId: binding.sessionId });
    signal.addEventListener("abort", abort, { once: true });

    try {
      await this.notifySessionMetadata(context, binding.sessionId, binding.snapshot);
      await (await this.getBridge()).request(
        "sendPrompt",
        {
          workspacePath: binding.workspacePath,
          sessionId: binding.sessionId,
          inputId: crypto.randomUUID(),
          content: prompt.content,
          attachments: prompt.attachments,
        },
        SendPromptResultSchema,
        60_000,
      );
      return await completion.promise;
    } catch (error) {
      settleTurn(turn, "reject", error);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
      if (binding.active === turn) delete binding.active;
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const binding = this.sessions.get(params.sessionId);
    const turn = binding?.active;
    if (binding === undefined || turn === undefined || turn.cancelled) return;
    turn.cancelled = true;
    await (await this.getBridge()).request(
      "stopSession",
      { workspacePath: binding.workspacePath, sessionId: binding.sessionId },
      UnknownResultSchema,
    );
    turn.cancelTimer = setTimeout(() => {
      settleTurn(
        turn,
        "reject",
        new AdapterError("NATIVE_TIMEOUT", "ZCode did not emit a terminal event after cancellation"),
      );
    }, 30_000);
  }

  async close(): Promise<void> {
    for (const binding of this.sessions.values()) {
      if (binding.active !== undefined) {
        binding.active.cancelled = true;
        settleTurn(binding.active, "resolve", { stopReason: "cancelled" });
      }
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((binding) => binding.subscription.dispose()));
    if (this.bridgePromise !== undefined) {
      await (await this.bridgePromise).close();
    }
  }

  private async initializeWorkspace(workspacePath: string): Promise<void> {
    const bridge = await this.getBridge();
    const initialized = await bridge.request(
      "initialize",
      { workspacePath },
      InitializeResultSchema,
      60_000,
    );
    if (!initialized.available) {
      throw new AdapterError(
        initialized.reasonCode === "provider_not_ready" ? "AUTH_REQUIRED" : "NATIVE_PROTOCOL_ERROR",
        initialized.reason ?? "ZCode headless host is unavailable",
      );
    }
    const state = await bridge.request(
      "readWorkspaceState",
      { workspacePath },
      WorkspaceStateResultSchema,
      60_000,
    );
    if ((state.modelCatalog?.providers.length ?? 0) === 0) {
      throw new AdapterError(
        "AUTH_REQUIRED",
        "No usable ZCode model provider is configured. Run zcode-acp login, then retry.",
      );
    }
  }

  private async resumeSnapshot(
    cwd: string,
    sessionId: string,
    mcpServers: acp.McpServer[],
  ): Promise<SessionSnapshot> {
    const workspace = await resolveWorkspace(cwd);
    await this.initializeWorkspace(workspace.cwd);
    const snapshot = await (await this.getBridge()).request(
      "resumeSession",
      { workspacePath: workspace.cwd, sessionId, mcpServers },
      SessionSnapshotSchema,
      60_000,
    );
    if (snapshot.session.workspace.workspacePath !== workspace.cwd) {
      throw new AdapterError("INVALID_WORKSPACE", "Session belongs to a different workspace");
    }
    await this.bindSnapshot(workspace.cwd, snapshot);
    return snapshot;
  }

  private async bindSnapshot(
    workspacePath: string,
    snapshot: SessionSnapshot,
  ): Promise<SessionBinding> {
    const previous = this.sessions.get(snapshot.session.sessionId);
    if (previous !== undefined) {
      previous.settings = snapshot.settings;
      previous.snapshot = snapshot;
      return previous;
    }
    let binding: SessionBinding | undefined;
    const bufferedEvents: DynamicEvent[] = [];
    const subscription = await (await this.getBridge()).subscribe(
      {
        workspacePath,
        sessionId: snapshot.session.sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: true,
      },
      (event) => {
        if (binding === undefined) {
          bufferedEvents.push(event);
          return;
        }
        return this.handleDynamicEvent(binding, event);
      },
    );
    binding = {
      sessionId: snapshot.session.sessionId,
      workspacePath,
      subscription,
      settings: snapshot.settings,
      snapshot,
    };
    this.sessions.set(binding.sessionId, binding);
    for (const event of bufferedEvents) await this.handleDynamicEvent(binding, event);
    return binding;
  }

  private async notifySessionMetadata(
    context: acp.AgentContext,
    sessionId: string,
    snapshot: SessionSnapshot,
  ): Promise<void> {
    await context.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: availableCommands(snapshot),
      },
    });
    await context.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: configOptions(snapshot.settings),
      },
    });
    await context.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: snapshot.settings.mode.current,
      },
    });
    await context.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        ...(snapshot.session.title === undefined ? {} : { title: snapshot.session.title }),
        ...(snapshot.session.updatedAt === undefined
          ? {}
          : { updatedAt: new Date(snapshot.session.updatedAt).toISOString() }),
      },
    });
    const usage = snapshot.runtime.contextUsage;
    if (usage !== undefined) {
      await context.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: usage.used,
          size: usage.size,
          ...(usage.cost == null ? {} : { cost: usage.cost }),
        },
      });
    }
    if ((snapshot.todos?.length ?? 0) > 0) {
      await context.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "plan",
          entries: snapshot.todos!.map((todo) => ({
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
          })),
        },
      });
    }
  }

  private requireSession(sessionId: string): SessionBinding {
    const binding = this.sessions.get(sessionId);
    if (binding === undefined) {
      throw new AdapterError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`);
    }
    return binding;
  }

  private async getBridge(): Promise<ZCodeHostBridge> {
    this.bridgePromise ??= (async () => {
      const runtime = await discoverRuntime(this.discoveryOptions);
      assertRuntimeSupported(runtime);
      return ZCodeHostBridge.start(
        runtime,
        this.logger,
        this.discoveryOptions.environment ?? process.env,
      );
    })();
    return this.bridgePromise;
  }

  private async handleDynamicEvent(binding: SessionBinding, dynamic: DynamicEvent): Promise<void> {
    const turn = binding.active;
    if (dynamic.type === "snapshot") {
      binding.settings = dynamic.snapshot.settings;
      binding.snapshot = dynamic.snapshot;
      if (turn !== undefined) {
        await this.notifySessionMetadata(turn.context, binding.sessionId, dynamic.snapshot);
      }
      return;
    }
    if (dynamic.type === "state.updated" || dynamic.type === "userInput.response") {
      return;
    }
    if (dynamic.type === "providerRuntimeHeaders.request") {
      await this.respondProviderHeadersUnavailable(binding, dynamic.request.requestId);
      if (turn !== undefined) {
        settleTurn(
          turn,
          "reject",
          new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "ZCode requested interactive provider header recovery, which is unavailable headlessly",
          ),
        );
      }
      return;
    }
    if (dynamic.type === "userInput.request") {
      await this.handleUserInput(binding, turn, dynamic.request);
      return;
    }
    if (turn === undefined) {
      this.logger.log("debug", "zcode.event.outside_turn", { type: dynamic.type });
      return;
    }

    try {
      if (dynamic.type === "permission.request") {
        await this.handlePermission(binding, turn, dynamic.request);
        return;
      }
      await this.handleSessionEvent(binding, turn, dynamic.event);
    } catch (error) {
      settleTurn(turn, "reject", error);
      void this.cancel({ sessionId: binding.sessionId });
    }
  }

  private async handlePermission(
    binding: SessionBinding,
    turn: ActiveTurn,
    request: PermissionRequest,
  ): Promise<void> {
    let mapped: acp.PermissionOption[];
    try {
      mapped = request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: permissionKind(option.response),
      } satisfies acp.PermissionOption));
    } catch (error) {
      await this.respondPermission(
        binding,
        request.requestId,
        denyResponse(request, "Native permission options cannot be represented in ACP v1"),
      );
      throw error;
    }
    let response: PermissionResponse;
    try {
      const result = await turn.context.request<
        acp.RequestPermissionResponse,
        acp.RequestPermissionRequest
      >("session/request_permission", {
        sessionId: binding.sessionId,
        toolCall: {
          toolCallId: request.toolCallId,
          title: request.reason || request.toolName,
          kind: toolKind(request.toolName),
          rawInput: request.input,
        },
        options: mapped,
      });
      const outcome = result.outcome;
      if (outcome.outcome === "selected") {
        const selected = request.options.find(
          (option) => option.optionId === outcome.optionId,
        );
        if (selected === undefined) {
          throw new AdapterError("NATIVE_PROTOCOL_ERROR", "ACP selected an unknown permission option");
        }
        response = selected.response;
      } else {
        response = denyResponse(request, "ACP client cancelled the permission request");
      }
    } catch (error) {
      response = denyResponse(request, "ACP permission request failed");
      await this.respondPermission(binding, request.requestId, response);
      throw error;
    }
    await this.respondPermission(binding, request.requestId, response);
  }

  private async handleUserInput(
    binding: SessionBinding,
    turn: ActiveTurn | undefined,
    request: UserInputRequest,
  ): Promise<void> {
    if (turn === undefined || !this.formElicitationSupported || request.questions === undefined) {
      await this.respondUserInput(binding, request.requestId, {
        action: "decline",
        reason: "ACP client does not support form elicitation",
      });
      if (turn !== undefined) {
        settleTurn(
          turn,
          "reject",
          new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "ZCode requested structured input but the ACP client cannot render form elicitation",
          ),
        );
      }
      return;
    }

    const properties: Record<string, acp.ElicitationPropertySchema> = {};
    for (const [index, question] of request.questions.entries()) {
      const key = `answer_${index}`;
      const options = question.options.map((option) => ({
        const: option.value,
        title: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      }));
      properties[key] = question.multiSelect
        ? {
            type: "array",
            title: question.header,
            description: question.question,
            items: { anyOf: options },
            minItems: 1,
          }
        : {
            type: "string",
            title: question.header,
            description: question.question,
            oneOf: options,
          };
    }

    try {
      const result = await turn.context.request<
        acp.CreateElicitationResponse,
        acp.CreateElicitationRequest
      >("elicitation/create", {
        mode: "form",
        sessionId: binding.sessionId,
        ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        message: request.prompt ?? "ZCode needs additional input",
        requestedSchema: {
          type: "object",
          properties,
          required: Object.keys(properties),
        },
      });
      if (result.action === "decline" || result.action === "cancel") {
        await this.respondUserInput(binding, request.requestId, { action: result.action });
        return;
      }
      if (result.action !== "accept") {
        throw new AdapterError(
          "INTERACTION_UNSUPPORTED",
          `Unsupported ACP elicitation action: ${result.action}`,
        );
      }
      const content = (result.content ?? {}) as Record<string, acp.ElicitationContentValue>;
      const answers = Object.fromEntries(request.questions.map((question, index) => {
        const value = content[`answer_${index}`];
        return [question.question, Array.isArray(value) ? value : value === undefined ? [] : [String(value)]];
      }));
      await this.respondUserInput(binding, request.requestId, {
        action: "accept",
        content: {
          ...content,
          answers,
          ...(request.questions.length === 1 ? { answer: content.answer_0 } : {}),
        },
      });
    } catch (error) {
      await this.respondUserInput(binding, request.requestId, {
        action: "decline",
        reason: "ACP elicitation failed",
      });
      throw error;
    }
  }

  private async respondUserInput(
    binding: SessionBinding,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await (await this.getBridge()).request(
      "respondUserInput",
      {
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        requestId,
        response,
      },
      UnknownResultSchema,
    );
  }

  private async respondPermission(
    binding: SessionBinding,
    requestId: string,
    response: PermissionResponse,
  ): Promise<void> {
    await (await this.getBridge()).request(
      "respondPermission",
      {
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        requestId,
        response,
      },
      UnknownResultSchema,
    );
  }

  private async respondProviderHeadersUnavailable(
    binding: SessionBinding,
    requestId: string,
  ): Promise<void> {
    await (await this.getBridge()).request(
      "respondProviderRuntimeHeaders",
      {
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        requestId,
        response: {
          headersApplied: false,
          errorMessage: "Interactive provider recovery is unavailable in the headless ACP adapter",
        },
      },
      UnknownResultSchema,
    );
  }

  private async handleSessionEvent(
    binding: SessionBinding,
    turn: ActiveTurn,
    event: SessionEvent,
  ): Promise<void> {
    if (event.type === "model.streaming") {
      await this.handleStreaming(binding, turn, event.payload);
      return;
    }
    if (event.type === "tool.updated") {
      await this.handleToolUpdate(binding, turn, event.payload);
      return;
    }
    if (event.type === "turn.completed") {
      const usage = await (await this.getBridge()).request(
        "getTaskTokenUsage",
        { workspacePath: binding.workspacePath, sessionId: binding.sessionId },
        TokenUsageSchema,
      );
      const acpUsage: acp.Usage = {
        totalTokens: usage.totalTokens,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thoughtTokens: usage.reasoningTokens,
        cachedReadTokens: usage.cacheReadTokens,
        cachedWriteTokens: usage.cacheCreationTokens,
      };
      const snapshot = await (await this.getBridge()).request(
        "readSession",
        {
          workspacePath: binding.workspacePath,
          sessionId: binding.sessionId,
          deliveryKind: "desktop-continuous",
          messageLimit: 1,
          afterSeq: 0,
        },
        SessionSnapshotSchema,
      );
      binding.settings = snapshot.settings;
      binding.snapshot = snapshot;
      await this.notifySessionMetadata(turn.context, binding.sessionId, snapshot);
      settleTurn(turn, "resolve", {
        stopReason: stopReason(event.payload, turn.cancelled),
        usage: acpUsage,
      });
      return;
    }
    if (event.type === "session.titleUpdated") {
      const title = stringValue(event.payload.title);
      if (title !== undefined) {
        await turn.context.notify("session/update", {
          sessionId: binding.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title,
            updatedAt: new Date(event.timestamp).toISOString(),
          },
        });
      }
      return;
    }
    if (event.type === "turn.failed") {
      if (turn.cancelled) {
        settleTurn(turn, "resolve", { stopReason: "cancelled" });
        return;
      }
      const error = asRecord(event.payload.error);
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        typeof error.message === "string" ? error.message : "ZCode turn failed",
      );
    }
    if (IgnoredSessionEvents.has(event.type)) return;
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Unsupported ZCode event: ${event.type}`);
  }

  private async handleStreaming(
    binding: SessionBinding,
    turn: ActiveTurn,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const kind = stringValue(payload.kind);
    const delta = stringValue(payload.delta) ?? "";
    const messageId = stringValue(payload.assistantMessageId);
    if (kind === "text_delta" || kind === "reasoning_delta") {
      if (!delta) return;
      await turn.context.notify("session/update", {
        sessionId: binding.sessionId,
        update: {
          sessionUpdate: kind === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { type: "text", text: delta },
          ...(messageId === undefined ? {} : { messageId }),
        },
      });
      return;
    }

    const toolCallId = stringValue(payload.toolCallId);
    if (toolCallId === undefined) {
      throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Missing toolCallId for stream kind: ${kind}`);
    }
    const tool = turn.tools.get(toolCallId) ?? {
      id: toolCallId,
      name: stringValue(payload.toolName) ?? "tool",
      rawInputText: "",
      created: false,
    };
    turn.tools.set(toolCallId, tool);
    if (kind === "tool_input_start") {
      tool.name = stringValue(payload.toolName) ?? tool.name;
      tool.rawInputText = "";
      return;
    }
    if (kind === "tool_input_delta") {
      tool.rawInputText += delta;
      return;
    }
    if (kind === "tool_input_end") return;
    if (kind === "tool_call") {
      tool.name = stringValue(payload.toolName) ?? tool.name;
      await this.createToolCall(binding, turn, tool, payload.input);
      return;
    }
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Unsupported model stream kind: ${kind}`);
  }

  private async createToolCall(
    binding: SessionBinding,
    turn: ActiveTurn,
    tool: ToolState,
    input?: unknown,
  ): Promise<void> {
    if (tool.created) return;
    tool.created = true;
    await turn.context.notify("session/update", {
      sessionId: binding.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: tool.id,
        title: tool.name,
        kind: toolKind(tool.name),
        status: "pending",
        rawInput: input ?? parseJson(tool.rawInputText),
      },
    });
  }

  private async handleToolUpdate(
    binding: SessionBinding,
    turn: ActiveTurn,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const kind = stringValue(payload.kind);
    if (kind === "batch") return;
    const id = stringValue(payload.toolCallId);
    if (id === undefined) throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Tool update has no ID");
    const tool = turn.tools.get(id) ?? {
      id,
      name: stringValue(payload.toolName) ?? "tool",
      rawInputText: "",
      created: false,
    };
    turn.tools.set(id, tool);
    if (kind === "scheduled") {
      await this.createToolCall(binding, turn, tool);
      return;
    }
    await this.createToolCall(binding, turn, tool);
    if (kind === "started") {
      await this.updateTool(binding, turn, { toolCallId: id, status: "in_progress" });
      return;
    }
    if (kind === "result") {
      const result = payload.result;
      await this.updateTool(binding, turn, {
        toolCallId: id,
        status: "completed",
        rawOutput: result,
        content: textToolContent(result),
      });
      return;
    }
    if (kind === "error") {
      const error = asRecord(payload.error);
      await this.updateTool(binding, turn, {
        toolCallId: id,
        status: "failed",
        rawOutput: payload.error,
        content: textToolContent(
          typeof error.message === "string" ? error.message : "Tool execution failed",
        ),
      });
      return;
    }
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Unsupported tool update kind: ${kind}`);
  }

  private async updateTool(
    binding: SessionBinding,
    turn: ActiveTurn,
    update: acp.ToolCallUpdate,
  ): Promise<void> {
    await turn.context.notify("session/update", {
      sessionId: binding.sessionId,
      update: { sessionUpdate: "tool_call_update", ...update },
    });
  }
}

interface NativeAttachment {
  kind: "image" | "audio" | "file";
  filename: string;
  mimeType: string;
  dataBase64?: string;
  textContent?: string;
  localPath?: string;
  sizeBytes?: number;
}

export function nativePrompt(blocks: acp.ContentBlock[]): {
  content: string;
  attachments: NativeAttachment[];
} {
  const content: string[] = [];
  const attachments: NativeAttachment[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      if (block.uri.startsWith("file:")) {
        const localPath = fileURLToPath(block.uri);
        if (!isAbsolute(localPath)) {
          throw new AdapterError("UNSUPPORTED_CONTENT", "Resource link path must be absolute");
        }
        attachments.push({
          kind: "file",
          filename: block.name || basename(localPath),
          mimeType: block.mimeType ?? "application/octet-stream",
          localPath,
          ...(block.size == null ? {} : { sizeBytes: block.size }),
        });
      } else {
        content.push(`${block.name}: ${block.uri}`);
      }
      continue;
    }
    if (block.type === "image" || block.type === "audio") {
      attachments.push({
        kind: block.type,
        filename: attachmentFilename(
          block.type === "image" ? block.uri ?? undefined : undefined,
          block.mimeType,
          block.type,
        ),
        mimeType: block.mimeType,
        dataBase64: block.data,
        sizeBytes: Buffer.from(block.data, "base64").byteLength,
      });
      continue;
    }
    if (block.type === "resource") {
      const resource = block.resource;
      const filename = resourceFilename(resource.uri, resource.mimeType ?? undefined);
      if ("text" in resource) {
        attachments.push({
          kind: "file",
          filename,
          mimeType: resource.mimeType ?? "text/plain",
          textContent: resource.text,
          sizeBytes: Buffer.byteLength(resource.text),
        });
      } else {
        attachments.push({
          kind: "file",
          filename,
          mimeType: resource.mimeType ?? "application/octet-stream",
          dataBase64: resource.blob,
          sizeBytes: Buffer.from(resource.blob, "base64").byteLength,
        });
      }
      continue;
    }
    throw new AdapterError("UNSUPPORTED_CONTENT", `Unsupported prompt content block`);
  }
  return { content: content.join("\n\n"), attachments };
}

function attachmentFilename(
  uri: string | undefined,
  mimeType: string,
  kind: "image" | "audio",
): string {
  if (uri !== undefined) {
    try {
      const name = basename(new URL(uri).pathname);
      if (name) return name;
    } catch {
      // The URI is optional metadata; payload bytes remain authoritative.
    }
  }
  return `${kind}.${mimeType.split("/")[1]?.split("+")[0] ?? "bin"}`;
}

function resourceFilename(uri: string, mimeType: string | undefined): string {
  try {
    const name = basename(new URL(uri).pathname);
    if (name) return name;
  } catch {
    // A resource URI can use an implementation-specific scheme.
  }
  return `context.${mimeType?.split("/")[1]?.split("+")[0] ?? "bin"}`;
}

function assertNoAdditionalDirectories(directories: string[] | undefined): void {
  if ((directories?.length ?? 0) !== 0) {
    throw new AdapterError(
      "INVALID_CONFIGURATION",
      "Installed ZCode host does not support ACP additionalDirectories",
    );
  }
}

function sessionSetupResponse(snapshot: SessionSnapshot): acp.NewSessionResponse {
  return {
    sessionId: snapshot.session.sessionId,
    ...sessionState(snapshot),
  };
}

function sessionState(snapshot: SessionSnapshot): acp.LoadSessionResponse {
  return {
    modes: {
      currentModeId: snapshot.settings.mode.current,
      availableModes: MODE_OPTIONS,
    },
    configOptions: configOptions(snapshot.settings),
  };
}

function configOptions(settings: SessionSettings): acp.SessionConfigOption[] {
  const result: acp.SessionConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelValue(settings.model.current),
      options: settings.model.available.map((model) => ({
        value: modelValue(model.ref),
        name: model.label,
        ...(model.providerLabel === undefined ? {} : { description: model.providerLabel }),
      })),
    },
  ];
  const thought = settings.thoughtLevel;
  if (thought.enabled && thought.current !== undefined && thought.available.length > 0) {
    result.push({
      id: THOUGHT_CONFIG_ID,
      name: "Thought level",
      category: "thought_level",
      type: "select",
      currentValue: thought.current,
      options: thought.available.map((option) => ({
        value: option.value,
        name: option.label,
      })),
    });
  }
  return result;
}

function modelValue(model: { providerId: string; modelId: string; variant?: string }): string {
  return JSON.stringify([model.providerId, model.modelId, model.variant ?? null]);
}

function availableCommands(snapshot: SessionSnapshot): acp.AvailableCommand[] {
  return snapshot.slashCommands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.inputHint === undefined
      ? {}
      : { input: { hint: command.inputHint } }),
  }));
}

function permissionKind(response: PermissionResponse): acp.PermissionOptionKind {
  const persistent = (response.permissionUpdates?.length ?? 0) > 0;
  if (response.decision === "allow") return persistent ? "allow_always" : "allow_once";
  if (response.decision === "deny") return persistent ? "reject_always" : "reject_once";
  throw new AdapterError(
    "INTERACTION_UNSUPPORTED",
    `Native permission decision cannot be represented in ACP v1: ${response.decision}`,
  );
}

function denyResponse(request: PermissionRequest, reason: string): PermissionResponse {
  return request.options.find((option) => option.response.decision === "deny")?.response ?? {
    decision: "deny",
    reason,
  };
}

function toolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase();
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "edit";
  if (normalized.includes("delete") || normalized.includes("remove")) return "delete";
  if (normalized.includes("move") || normalized.includes("rename")) return "move";
  if (normalized.includes("search") || normalized.includes("grep") || normalized.includes("glob")) {
    return "search";
  }
  if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
    return "execute";
  }
  if (normalized.includes("fetch") || normalized.includes("web")) return "fetch";
  if (normalized.includes("think") || normalized.includes("plan")) return "think";
  return "other";
}

function persistedToolStatus(status: string | undefined): acp.ToolCallStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "in_progress";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported persisted tool status: ${String(status)}`,
      );
  }
}

function textToolContent(value: unknown): acp.ToolCallContent[] {
  const record = asRecord(value);
  const content = typeof record.content === "string"
    ? record.content
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  if (!content) return [];
  return [{ type: "content", content: { type: "text", text: content } }];
}

function stopReason(
  payload: Record<string, unknown>,
  cancelled: boolean,
): acp.StopReason {
  if (cancelled) return "cancelled";
  switch (stringValue(payload.resultType)) {
    case "success":
      return "end_turn";
    case "max_tokens":
    case "token_limit":
      return "max_tokens";
    case "max_turn_requests":
    case "request_limit":
      return "max_turn_requests";
    case "refusal":
      return "refusal";
    case "cancelled":
    case "interrupted":
    case "stopped":
      return "cancelled";
    default:
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Unsupported ZCode terminal result: ${String(payload.resultType)}`,
      );
  }
}

function settleTurn(
  turn: ActiveTurn,
  action: "resolve" | "reject",
  value: acp.PromptResponse | unknown,
): void {
  if (turn.settled) return;
  turn.settled = true;
  if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
  if (action === "resolve") turn.resolve(value as acp.PromptResponse);
  else turn.reject(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
