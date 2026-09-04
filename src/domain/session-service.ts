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
import type {
  AvailableCommand,
  McpServer,
  PromptContentBlock,
  PromptResult,
  SessionConfigOption,
  SessionEngine,
  SessionInteraction,
  SessionMode,
  SessionSetup,
  SessionState,
  SessionUpdate,
} from "./session-contract.ts";
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

interface ToolState {
  readonly id: string;
  name: string;
  rawInputText: string;
  created: boolean;
  status: "pending" | "in_progress" | "completed" | "failed";
}

interface ActiveTurn {
  readonly inputId: string;
  readonly startedAt: number;
  readonly interaction: SessionInteraction;
  readonly resolve: (response: PromptResult) => void;
  readonly reject: (error: unknown) => void;
  readonly tools: Map<string, ToolState>;
  cancelled: boolean;
  settled: boolean;
  metadataDurationMs?: number;
  hostResponseDurationMs?: number;
  firstEventDurationMs?: number;
  cancelTimer?: ReturnType<typeof setTimeout>;
  planProposal?: {
    readonly planId: string;
    readonly markdown: string;
  };
}

interface SessionBinding {
  readonly sessionId: string;
  readonly workspacePath: string;
  subscription: HostSubscription;
  settings: SessionSettings;
  snapshot: SessionSnapshot;
  advertisedConfig: AdvertisedConfig;
  todosPlanVisible: boolean;
  legacyPlanVisible: boolean;
  active?: ActiveTurn;
}

type ModelRef = SessionSettings["model"]["available"][number]["ref"];

interface AdvertisedConfig {
  readonly modelRefsByValue: ReadonlyMap<string, ModelRef>;
  readonly thoughtLevels: ReadonlySet<string>;
}

interface NativePermissionAnswer {
  readonly optionId: string;
  readonly response: PermissionResponse;
}

interface NativePlanApprovalOption {
  readonly optionId: string;
  readonly name: string;
  readonly description?: string;
}

const TODOS_PLAN_ID = "zcode-todos";
const PLAN_PROPOSAL_PREFIX = "zcode-plan-proposal:";

export const MODE_OPTIONS = [
  { id: "build", name: "Ask before changes", description: "Ask before each file changes." },
  {
    id: "edit",
    name: "Edit automatically",
    description: "Edit selected files or relevant workspace files automatically.",
  },
  { id: "plan", name: "Plan mode", description: "Inspect the code and present a plan before editing." },
  { id: "yolo", name: "Full access", description: "Edit and run commands with fewer confirmations." },
] as const satisfies readonly SessionMode[];

type ZCodeModeId = (typeof MODE_OPTIONS)[number]["id"];

const MODEL_CONFIG_ID = "zcode.model";
const THOUGHT_CONFIG_ID = "zcode.thought_level";

const IgnoredSessionEvents = new Set([
  "session.updated",
  "streamRecovery.updated",
  "turn.started",
  "permission.requested",
  "permission.resolved",
  "checkpoint.created",
]);

export class HeadlessZCodeSessionEngine implements SessionEngine {
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly workspaceCommands = new Map<string, AvailableCommand[]>();
  private bridgePromise: Promise<ZCodeHostBridge> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly discoveryOptions: DiscoveryOptions = {},
  ) {}

  async newSession(params: {
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[];
  }): Promise<SessionSetup> {
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

  async getWorkspaceSettings(cwd: string): Promise<SessionSettings> {
    const workspace = await resolveWorkspace(cwd);
    await this.initializeWorkspace(workspace.cwd);
    const state = await (await this.getBridge()).request(
      "readWorkspaceState",
      { workspacePath: workspace.cwd },
      WorkspaceStateResultSchema,
      60_000,
    );
    return state.settings;
  }

  async getWorkspaceCommands(cwd: string): Promise<AvailableCommand[]> {
    const workspace = await resolveWorkspace(cwd);
    return [...(this.workspaceCommands.get(workspace.cwd) ?? [])];
  }

  async reconfigureSessionMcp(
    cwd: string,
    sessionId: string,
    mcpServers: McpServer[],
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing?.active !== undefined) {
      throw new AdapterError("SESSION_BUSY", "MCP configuration cannot change during a turn");
    }
    const snapshot = await this.resumeSnapshot(cwd, sessionId, mcpServers);
    return sessionState(snapshot);
  }

  async loadSession(
    params: {
      cwd: string;
      sessionId: string;
      mcpServers: McpServer[];
      additionalDirectories?: string[];
    },
    interaction: SessionInteraction,
  ): Promise<SessionState> {
    assertNoAdditionalDirectories(params.additionalDirectories);
    const snapshot = await this.resumeSnapshot(params.cwd, params.sessionId, params.mcpServers);
    for (const message of snapshot.messages) {
      for (const part of message.parts) {
        const text = stringValue(part.text);
        if (text !== undefined && (part.type === "text" || part.type === "reasoning")) {
          await interaction.notify(params.sessionId, {
              sessionUpdate: message.info.role === "user"
                ? "user_message_chunk"
                : part.type === "reasoning"
                  ? "agent_thought_chunk"
                  : "agent_message_chunk",
              content: { type: "text", text },
              messageId: message.info.messageId,
          });
          continue;
        }
        if (part.type === "file") {
          const uri = stringValue(part.url);
          if (uri === undefined) continue;
          await interaction.notify(params.sessionId, {
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
          await interaction.notify(params.sessionId, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: stringValue(state.title) ?? name,
              kind: toolKind(name),
              status,
              rawInput: state.input,
              ...(output === undefined ? {} : { rawOutput: output, content: textToolContent(output) }),
          });
        }
      }
    }
    await this.notifySessionMetadata(interaction, params.sessionId, snapshot);
    return sessionState(snapshot);
  }

  async resumeSession(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: McpServer[];
    additionalDirectories?: string[];
  }): Promise<SessionState> {
    assertNoAdditionalDirectories(params.additionalDirectories);
    const snapshot = await this.resumeSnapshot(params.cwd, params.sessionId, params.mcpServers ?? []);
    return sessionState(snapshot);
  }

  async listSessions(params: { cwd?: string | null; cursor?: string | null }): Promise<{
    sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>;
  }> {
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

  async closeSession(params: { sessionId: string }): Promise<void> {
    const binding = this.sessions.get(params.sessionId);
    if (binding === undefined) return;
    if (binding.active !== undefined) await this.cancel({ sessionId: params.sessionId });
    await (await this.getBridge()).request(
      "closeSession",
      { workspacePath: binding.workspacePath, sessionId: binding.sessionId },
      UnknownResultSchema,
    );
    await binding.subscription.dispose();
    this.sessions.delete(params.sessionId);
  }

  async setSessionMode(
    params: { sessionId: string; modeId: string },
    interaction?: SessionInteraction,
  ): Promise<void> {
    if (!isZCodeModeId(params.modeId)) {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown ZCode mode: ${params.modeId}`);
    }
    const binding = this.requireSession(params.sessionId);
    const snapshot = await (await this.getBridge()).request(
      "setMode",
      { workspacePath: binding.workspacePath, sessionId: binding.sessionId, mode: params.modeId },
      SessionSnapshotSchema,
      60_000,
    );
    const currentModeId = updateBindingSnapshot(binding, snapshot);
    if (interaction !== undefined) {
      await interaction.notify(binding.sessionId, {
        sessionUpdate: "current_mode_update",
        currentModeId,
      });
    }
  }

  async setSessionConfigOption(
    params: { sessionId: string; configId: string; value: unknown; type?: string },
    interaction?: SessionInteraction,
  ): Promise<{ configOptions: SessionConfigOption[] }> {
    const binding = this.requireSession(params.sessionId);
    if (params.configId === MODEL_CONFIG_ID && !("type" in params)) {
      const selected = typeof params.value === "string"
        ? binding.advertisedConfig.modelRefsByValue.get(params.value)
        : undefined;
      if (selected === undefined) {
        throw new AdapterError("INVALID_CONFIGURATION", `Unknown ZCode model: ${params.value}`);
      }
      const snapshot = await (await this.getBridge()).request(
        "setModel",
        {
          workspacePath: binding.workspacePath,
          sessionId: binding.sessionId,
          model: selected,
          persistAsWorkspaceLastUsed: true,
        },
        SessionSnapshotSchema,
        60_000,
      );
      updateBindingSnapshot(binding, snapshot);
      updateAdvertisedConfig(binding, snapshot.settings);
    } else if (params.configId === THOUGHT_CONFIG_ID && !("type" in params)) {
      if (
        typeof params.value !== "string" ||
        !binding.advertisedConfig.thoughtLevels.has(params.value)
      ) {
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
      updateBindingSnapshot(binding, snapshot);
      updateAdvertisedConfig(binding, snapshot.settings);
    } else {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown config option: ${params.configId}`);
    }
    const options = configOptions(binding.settings);
    if (interaction !== undefined) {
      await interaction.notify(binding.sessionId, {
        sessionUpdate: "config_option_update",
        configOptions: options,
      });
    }
    return { configOptions: options };
  }

  async authenticate(): Promise<void> {
    const runtime = await discoverRuntime(this.discoveryOptions);
    const smoke = await runRuntimeSmoke(
      runtime,
      this.discoveryOptions.environment ?? process.env,
    );
    if (smoke.authentication !== "present") {
      throw new AdapterError("AUTH_REQUIRED", "ZCode login has not completed");
    }
  }

  async logout(): Promise<void> {
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
  }

  async prompt(
    params: { sessionId: string; prompt: PromptContentBlock[] },
    interaction: SessionInteraction,
    signal: AbortSignal,
  ): Promise<PromptResult> {
    const binding = this.sessions.get(params.sessionId);
    if (binding === undefined) {
      throw new AdapterError("SESSION_NOT_FOUND", `Unknown session: ${params.sessionId}`);
    }
    if (binding.active !== undefined) {
      throw new AdapterError("SESSION_BUSY", "A prompt is already active for this session");
    }

    const inputId = crypto.randomUUID();
    const startedAt = performance.now();
    this.logger.log("info", "acp.session_prompt.started", {
      sessionId: binding.sessionId,
      inputId,
    });
    let prompt: ReturnType<typeof nativePrompt>;
    try {
      prompt = nativePrompt(params.prompt);
    } catch (error) {
      this.logger.log("info", "acp.session_prompt.completed", {
        sessionId: binding.sessionId,
        inputId,
        outcome: "error",
        totalDurationMs: elapsedMs(startedAt),
      });
      throw error;
    }
    const completion = Promise.withResolvers<PromptResult>();
    const turnInteraction: SessionInteraction = {
      planOperationsSupported: interaction.planOperationsSupported,
      notify: (sessionId, update) =>
        this.notifySessionUpdate(interaction, sessionId, update, inputId),
      requestPermission: (request) => interaction.requestPermission(request),
      requestPlanApproval: (request) => interaction.requestPlanApproval(request),
      requestUserInput: (request) => interaction.requestUserInput(request),
    };
    const turn: ActiveTurn = {
      inputId,
      startedAt,
      interaction: turnInteraction,
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
      const metadataStartedAt = performance.now();
      try {
        await this.notifySessionMetadata(turnInteraction, binding.sessionId, binding.snapshot);
      } finally {
        turn.metadataDurationMs = elapsedMs(metadataStartedAt);
      }

      const hostStartedAt = performance.now();
      this.logger.log("debug", "zcode.host_request.started", {
        sessionId: binding.sessionId,
        inputId,
        operation: "sendPrompt",
      });
      try {
        await (await this.getBridge()).request(
          "sendPrompt",
          {
            workspacePath: binding.workspacePath,
            sessionId: binding.sessionId,
            inputId,
            content: prompt.content,
            attachments: prompt.attachments,
          },
          SendPromptResultSchema,
          60_000,
          { sessionId: binding.sessionId, inputId },
        );
        turn.hostResponseDurationMs = elapsedMs(hostStartedAt);
        this.logger.log("debug", "zcode.host_request.completed", {
          sessionId: binding.sessionId,
          inputId,
          operation: "sendPrompt",
          outcome: "success",
          durationMs: turn.hostResponseDurationMs,
        });
      } catch (error) {
        turn.hostResponseDurationMs = elapsedMs(hostStartedAt);
        this.logger.log("debug", "zcode.host_request.completed", {
          sessionId: binding.sessionId,
          inputId,
          operation: "sendPrompt",
          outcome: "error",
          durationMs: turn.hostResponseDurationMs,
        });
        throw error;
      }

      const result = await completion.promise;
      this.logPromptCompleted(binding.sessionId, turn, "success", result.stopReason);
      return result;
    } catch (error) {
      await this.removePlanProposal(binding, turn);
      settleTurn(turn, "reject", error);
      this.logPromptCompleted(binding.sessionId, turn, "error");
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
      if (binding.active === turn) delete binding.active;
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const binding = this.sessions.get(params.sessionId);
    const turn = binding?.active;
    if (binding === undefined || turn === undefined || turn.cancelled) return;
    turn.cancelled = true;
    try {
      await this.removePlanProposal(binding, turn);
    } finally {
      await (await this.getBridge()).request(
        "cancelGeneration",
        { workspacePath: binding.workspacePath, sessionId: binding.sessionId },
        UnknownResultSchema,
      );
    }
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
        try {
          await this.removePlanProposal(binding, binding.active);
        } catch (error) {
          this.logger.error("acp.plan_cleanup.failed", error, { sessionId: binding.sessionId });
        }
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
    mcpServers: McpServer[],
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
    requireZCodeModeId(snapshot.settings.mode.current);
    const previous = this.sessions.get(snapshot.session.sessionId);
    if (previous !== undefined) {
      updateBindingSnapshot(previous, snapshot);
      updateAdvertisedConfig(previous, snapshot.settings);
      this.workspaceCommands.set(workspacePath, availableCommands(snapshot));
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
      advertisedConfig: advertisedConfig(snapshot.settings),
      todosPlanVisible: false,
      legacyPlanVisible: false,
    };
    this.sessions.set(binding.sessionId, binding);
    this.workspaceCommands.set(workspacePath, availableCommands(snapshot));
    for (const event of bufferedEvents) await this.handleDynamicEvent(binding, event);
    return binding;
  }

  private async notifySessionMetadata(
    interaction: SessionInteraction,
    sessionId: string,
    snapshot: SessionSnapshot,
  ): Promise<void> {
    const currentModeId = requireZCodeModeId(snapshot.settings.mode.current);
    await interaction.notify(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: availableCommands(snapshot),
    });
    updateAdvertisedConfig(this.requireSession(sessionId), snapshot.settings);
    await interaction.notify(sessionId, {
      sessionUpdate: "config_option_update",
      configOptions: configOptions(snapshot.settings),
    });
    await interaction.notify(sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId,
    });
    await interaction.notify(sessionId, {
      sessionUpdate: "session_info_update",
      ...(snapshot.session.title === undefined ? {} : { title: snapshot.session.title }),
      ...(snapshot.session.updatedAt === undefined
        ? {}
        : { updatedAt: new Date(snapshot.session.updatedAt).toISOString() }),
    });
    const usage = snapshot.runtime.contextUsage;
    if (usage !== undefined) {
      await interaction.notify(sessionId, {
        sessionUpdate: "usage_update",
        used: usage.used,
        size: usage.size,
        ...(usage.cost == null ? {} : { cost: usage.cost }),
      });
    }
    await this.notifyTodos(this.requireSession(sessionId), interaction, snapshot.todos ?? []);
  }

  private async notifyTodos(
    binding: SessionBinding,
    interaction: SessionInteraction,
    todos: NonNullable<SessionSnapshot["todos"]>,
  ): Promise<void> {
    const entries = todoEntries(todos);
    if (interaction.planOperationsSupported) {
      if (entries.length > 0) {
        await interaction.notify(binding.sessionId, {
          sessionUpdate: "plan_update",
          plan: { type: "items", planId: TODOS_PLAN_ID, entries },
        });
        binding.todosPlanVisible = true;
      } else if (binding.todosPlanVisible) {
        await interaction.notify(binding.sessionId, {
          sessionUpdate: "plan_removed",
          planId: TODOS_PLAN_ID,
        });
        binding.todosPlanVisible = false;
      }
      return;
    }
    if (entries.length > 0 || binding.legacyPlanVisible) {
      await interaction.notify(binding.sessionId, { sessionUpdate: "plan", entries });
      binding.legacyPlanVisible = entries.length > 0;
    }
  }

  private async notifySessionUpdate(
    interaction: SessionInteraction,
    sessionId: string,
    update: SessionUpdate,
    inputId: string,
  ): Promise<void> {
    const startedAt = performance.now();
    const data = {
      sessionId,
      inputId,
      updateType: update.sessionUpdate,
    };
    this.logger.log("debug", "acp.session_update.started", data);
    try {
      await interaction.notify(sessionId, update);
      this.logger.log("debug", "acp.session_update.completed", {
        ...data,
        outcome: "success",
        durationMs: elapsedMs(startedAt),
      });
    } catch (error) {
      this.logger.log("debug", "acp.session_update.completed", {
        ...data,
        outcome: "error",
        durationMs: elapsedMs(startedAt),
      });
      throw error;
    }
  }

  private logPromptCompleted(
    sessionId: string,
    turn: ActiveTurn,
    outcome: "success" | "error",
    stopReason?: PromptResult["stopReason"],
  ): void {
    this.logger.log("info", "acp.session_prompt.completed", {
      sessionId,
      inputId: turn.inputId,
      outcome,
      ...(stopReason === undefined ? {} : { stopReason }),
      totalDurationMs: elapsedMs(turn.startedAt),
      ...(turn.metadataDurationMs === undefined
        ? {}
        : { metadataDurationMs: turn.metadataDurationMs }),
      ...(turn.hostResponseDurationMs === undefined
        ? {}
        : { hostResponseDurationMs: turn.hostResponseDurationMs }),
      ...(turn.firstEventDurationMs === undefined
        ? {}
        : { firstEventDurationMs: turn.firstEventDurationMs }),
    });
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
    if (turn !== undefined && turn.firstEventDurationMs === undefined) {
      turn.firstEventDurationMs = elapsedMs(turn.startedAt);
      this.logger.log("debug", "zcode.event.first_received", {
        sessionId: binding.sessionId,
        inputId: turn.inputId,
        eventType: dynamic.type,
        durationMs: turn.firstEventDurationMs,
      });
    }
    if (dynamic.type === "snapshot") {
      updateBindingSnapshot(binding, dynamic.snapshot);
      if (turn !== undefined) {
        await this.notifySessionMetadata(turn.interaction, binding.sessionId, dynamic.snapshot);
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
      try {
        if (isPlanApprovalUserInput(dynamic.request)) {
          await this.handleUserInputPlanApproval(binding, turn, dynamic.request);
        } else {
          await this.handleUserInput(binding, turn, dynamic.request);
        }
      } catch (error) {
        if (turn === undefined) throw error;
        settleTurn(turn, "reject", error);
        void this.cancel({ sessionId: binding.sessionId });
      }
      return;
    }
    if (turn === undefined) {
      this.logger.log("debug", "zcode.event.outside_turn", { type: dynamic.type });
      return;
    }

    try {
      if (dynamic.type === "permission.request") {
        if (dynamic.request.toolName === "ExitPlanMode") {
          await this.handlePermissionPlanApproval(binding, turn, dynamic.request);
        } else {
          await this.handlePermission(binding, turn, dynamic.request);
        }
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
    let answer: NativePermissionAnswer;
    try {
      const selection = await turn.interaction.requestPermission(request);
      if (selection !== null) {
        const selected = request.options.find(
          (option) => option.optionId === selection.optionId,
        );
        if (selected === undefined) {
          throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Client selected an unknown permission option");
        }
        answer = { optionId: selected.optionId, response: selected.response };
      } else {
        answer = denyAnswer(request);
      }
    } catch (error) {
      answer = denyAnswer(request);
      await this.respondPermission(binding, request.requestId, answer);
      throw error;
    }
    await this.respondPermission(binding, request.requestId, answer);
  }

  private async handlePermissionPlanApproval(
    binding: SessionBinding,
    turn: ActiveTurn,
    request: PermissionRequest,
  ): Promise<void> {
    let nativeResponseAttempted = false;
    try {
      const markdown = requirePlanMarkdown(request.input);
      const options = planPermissionOptions(request);
      const planId = `${PLAN_PROPOSAL_PREFIX}${request.requestId}`;
      await this.publishPlanProposal(binding, turn, planId, markdown);
      const result = await turn.interaction.requestPlanApproval({
        sessionId: request.sessionId,
        toolCallId: request.toolCallId,
        message: request.reason || "Review this implementation plan.",
        options,
      });
      if (result.action !== "accept") {
        const answer = denyAnswer(request);
        await this.removePlanProposal(binding, turn);
        nativeResponseAttempted = true;
        await this.respondPermission(binding, request.requestId, answer);
        return;
      }
      const selected = request.options.find((option) => option.optionId === result.optionId);
      if (selected === undefined) {
        throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Client selected an unknown plan option");
      }
      const answer = { optionId: selected.optionId, response: selected.response };
      if (selected.response.decision === "allow") {
        await this.markPlanProposalAccepted(binding, turn);
      } else {
        await this.removePlanProposal(binding, turn);
      }
      nativeResponseAttempted = true;
      await this.respondPermission(binding, request.requestId, answer);
    } catch (error) {
      try {
        if (!nativeResponseAttempted) {
          nativeResponseAttempted = true;
          await this.respondPermission(binding, request.requestId, denyAnswer(request));
        }
      } finally {
        await this.removePlanProposal(binding, turn);
      }
      throw error;
    }
  }

  private async handleUserInputPlanApproval(
    binding: SessionBinding,
    turn: ActiveTurn | undefined,
    request: UserInputRequest,
  ): Promise<void> {
    if (turn === undefined) {
      await this.respondUserInput(binding, request.requestId, {
        action: "decline",
        reason: "No active client can approve the plan",
      });
      return;
    }
    let nativeResponseAttempted = false;
    try {
      const markdown = requirePlanMarkdown(request.input);
      const normalized = planUserInputOptions(request);
      const planId = `${PLAN_PROPOSAL_PREFIX}${request.requestId}`;
      await this.publishPlanProposal(binding, turn, planId, markdown);
      const result = await turn.interaction.requestPlanApproval({
        sessionId: request.sessionId,
        ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        message: request.prompt ?? normalized.question,
        options: normalized.options,
      });
      if (result.action !== "accept") {
        await this.removePlanProposal(binding, turn);
        nativeResponseAttempted = true;
        await this.respondUserInput(binding, request.requestId, { action: result.action });
        return;
      }
      if (!normalized.options.some((option) => option.optionId === result.optionId)) {
        throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Client selected an unknown plan option");
      }
      await this.markPlanProposalAccepted(binding, turn);
      nativeResponseAttempted = true;
      await this.respondUserInput(binding, request.requestId, {
        action: "accept",
        content: structuredInputContent(normalized.question, result.optionId),
      });
    } catch (error) {
      try {
        if (!nativeResponseAttempted) {
          nativeResponseAttempted = true;
          await this.respondUserInput(binding, request.requestId, {
            action: "decline",
            reason: "Plan approval request failed",
          });
        }
      } finally {
        await this.removePlanProposal(binding, turn);
      }
      throw error;
    }
  }

  private async handleUserInput(
    binding: SessionBinding,
    turn: ActiveTurn | undefined,
    request: UserInputRequest,
  ): Promise<void> {
    if (turn === undefined || request.questions === undefined) {
      await this.respondUserInput(binding, request.requestId, {
        action: "decline",
        reason: "No active client can handle structured input",
      });
      if (turn !== undefined) {
        settleTurn(
          turn,
          "reject",
          new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "ZCode requested structured input without an active client interaction",
          ),
        );
      }
      return;
    }

    try {
      const result = await turn.interaction.requestUserInput(request);
      if (result.action !== "accept") {
        await this.respondUserInput(binding, request.requestId, { action: result.action });
        return;
      }
      await this.respondUserInput(binding, request.requestId, {
        action: "accept",
        content: result.content,
      });
    } catch (error) {
      await this.respondUserInput(binding, request.requestId, {
        action: "decline",
        reason: "Structured input request failed",
      });
      throw error;
    }
  }

  private async publishPlanProposal(
    binding: SessionBinding,
    turn: ActiveTurn,
    planId: string,
    markdown: string,
  ): Promise<void> {
    await this.removePlanProposal(binding, turn);
    if (turn.interaction.planOperationsSupported) {
      await turn.interaction.notify(binding.sessionId, {
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId, content: markdown },
      });
    } else {
      await turn.interaction.notify(binding.sessionId, {
        sessionUpdate: "plan",
        entries: [{ content: markdown, priority: "high", status: "pending" }],
      });
      binding.legacyPlanVisible = true;
    }
    turn.planProposal = { planId, markdown };
  }

  private async markPlanProposalAccepted(
    binding: SessionBinding,
    turn: ActiveTurn,
  ): Promise<void> {
    const proposal = turn.planProposal;
    if (proposal === undefined || turn.interaction.planOperationsSupported) return;
    await turn.interaction.notify(binding.sessionId, {
      sessionUpdate: "plan",
      entries: [{
        content: proposal.markdown,
        priority: "high",
        status: "in_progress",
      }],
    });
    binding.legacyPlanVisible = true;
  }

  private async removePlanProposal(binding: SessionBinding, turn: ActiveTurn): Promise<void> {
    const proposal = turn.planProposal;
    if (proposal === undefined) return;
    delete turn.planProposal;
    if (turn.interaction.planOperationsSupported) {
      await turn.interaction.notify(binding.sessionId, {
        sessionUpdate: "plan_removed",
        planId: proposal.planId,
      });
    } else {
      await turn.interaction.notify(binding.sessionId, { sessionUpdate: "plan", entries: [] });
      binding.legacyPlanVisible = false;
    }
  }

  private async finishPlanProposal(binding: SessionBinding, turn: ActiveTurn): Promise<void> {
    if (turn.interaction.planOperationsSupported) {
      await this.removePlanProposal(binding, turn);
    } else {
      delete turn.planProposal;
    }
  }

  private async respondUserInput(
    binding: SessionBinding,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await (await this.getBridge()).request(
      "respondStructuredInput",
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
    answer: NativePermissionAnswer,
  ): Promise<void> {
    await (await this.getBridge()).request(
      "respondPermission",
      {
        workspacePath: binding.workspacePath,
        sessionId: binding.sessionId,
        requestId,
        optionId: answer.optionId,
        response: answer.response,
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
      const usageResult: NonNullable<PromptResult["usage"]> = {
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
      updateBindingSnapshot(binding, snapshot);
      await this.notifySessionMetadata(turn.interaction, binding.sessionId, snapshot);
      await this.finishPlanProposal(binding, turn);
      settleTurn(turn, "resolve", {
        stopReason: stopReason(event.payload, turn.cancelled),
        usage: usageResult,
      });
      return;
    }
    if (event.type === "session.titleUpdated") {
      const title = stringValue(event.payload.title);
      if (title !== undefined) {
        await turn.interaction.notify(binding.sessionId, {
          sessionUpdate: "session_info_update",
          title,
          updatedAt: new Date(event.timestamp).toISOString(),
        });
      }
      return;
    }
    if (event.type === "turn.failed") {
      if (turn.cancelled) {
        await this.removePlanProposal(binding, turn);
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
      await turn.interaction.notify(binding.sessionId, {
        sessionUpdate: kind === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
        content: { type: "text", text: delta },
        ...(messageId === undefined ? {} : { messageId }),
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
      status: "pending" as const,
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
    await turn.interaction.notify(binding.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: tool.id,
      title: tool.name,
      kind: toolKind(tool.name),
      status: "pending",
      rawInput: input ?? parseJson(tool.rawInputText),
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
      status: "pending" as const,
    };
    turn.tools.set(id, tool);
    if (kind === "scheduled") {
      await this.createToolCall(binding, turn, tool);
      return;
    }
    if (kind === "started" || kind === "progress") {
      await this.markToolInProgress(binding, turn, tool, kind);
      return;
    }
    await this.createToolCall(binding, turn, tool);
    if (kind === "result") {
      const result = payload.result;
      await this.updateTool(binding, turn, {
        toolCallId: id,
        status: "completed",
        rawOutput: result,
        content: textToolContent(result),
      });
      tool.status = "completed";
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
      tool.status = "failed";
      return;
    }
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Unsupported tool update kind: ${kind}`);
  }

  private async markToolInProgress(
    binding: SessionBinding,
    turn: ActiveTurn,
    tool: ToolState,
    kind: "started" | "progress",
  ): Promise<void> {
    if (tool.status === "completed" || tool.status === "failed") {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `Invalid tool transition: ${kind} after ${tool.status}`,
      );
    }
    await this.createToolCall(binding, turn, tool);
    if (tool.status === "in_progress") return;
    await this.updateTool(binding, turn, { toolCallId: tool.id, status: "in_progress" });
    tool.status = "in_progress";
  }

  private async updateTool(
    binding: SessionBinding,
    turn: ActiveTurn,
    update: Record<string, unknown>,
  ): Promise<void> {
    await turn.interaction.notify(binding.sessionId, {
      sessionUpdate: "tool_call_update",
      ...update,
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

export function nativePrompt(blocks: PromptContentBlock[]): {
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

function sessionSetupResponse(snapshot: SessionSnapshot): SessionSetup {
  return {
    sessionId: snapshot.session.sessionId,
    ...sessionState(snapshot),
  };
}

function sessionState(snapshot: SessionSnapshot): SessionState {
  const currentModeId = requireZCodeModeId(snapshot.settings.mode.current);
  return {
    modes: {
      currentModeId,
      availableModes: MODE_OPTIONS.map((mode) => ({ ...mode })),
    },
    configOptions: configOptions(snapshot.settings),
  };
}

function isZCodeModeId(modeId: string): modeId is ZCodeModeId {
  return MODE_OPTIONS.some((mode) => mode.id === modeId);
}

function requireZCodeModeId(modeId: string): ZCodeModeId {
  if (!isZCodeModeId(modeId)) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      `ZCode returned a mode outside the published catalog: ${modeId}`,
    );
  }
  return modeId;
}

function updateBindingSnapshot(binding: SessionBinding, snapshot: SessionSnapshot): ZCodeModeId {
  const currentModeId = requireZCodeModeId(snapshot.settings.mode.current);
  binding.settings = snapshot.settings;
  binding.snapshot = snapshot;
  return currentModeId;
}

function updateAdvertisedConfig(binding: SessionBinding, settings: SessionSettings): void {
  binding.advertisedConfig = advertisedConfig(settings);
}

function advertisedConfig(settings: SessionSettings): AdvertisedConfig {
  const modelRefsByValue = new Map<string, ModelRef>();
  for (const option of settings.model.available) {
    const value = modelValue(option.ref);
    if (!modelRefsByValue.has(value)) modelRefsByValue.set(value, option.ref);
  }

  const thoughtLevels = new Set<string>();
  const thought = settings.thoughtLevel;
  if (thought.enabled && thought.current !== undefined && thought.available.length > 0) {
    for (const option of thought.available) thoughtLevels.add(option.value);
  }

  return { modelRefsByValue, thoughtLevels };
}

export function configOptions(settings: SessionSettings): SessionConfigOption[] {
  const result: SessionConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelValue(settings.model.current),
      options: settings.model.available.map((model) => ({
        value: modelValue(model.ref),
        // Match the official ZCode GUI model picker, which displays model IDs instead of host labels.
        name: model.ref.modelId,
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

export function availableCommands(snapshot: SessionSnapshot): AvailableCommand[] {
  return snapshot.slashCommands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.inputHint === undefined
      ? {}
      : { input: { hint: command.inputHint } }),
  }));
}

export function permissionKind(
  response: PermissionResponse,
): "allow_once" | "allow_always" | "reject_once" | "reject_always" {
  const persistent = (response.permissionUpdates?.length ?? 0) > 0;
  if (response.decision === "allow") return persistent ? "allow_always" : "allow_once";
  if (response.decision === "deny") return persistent ? "reject_always" : "reject_once";
  throw new AdapterError(
    "INTERACTION_UNSUPPORTED",
    `Native permission decision cannot be represented in ACP v1: ${response.decision}`,
  );
}

function isPlanApprovalUserInput(request: UserInputRequest): boolean {
  return asRecord(request.schema).interaction === "plan_approval";
}

function requirePlanMarkdown(input: unknown): string {
  const plan = asRecord(input).plan;
  if (typeof plan !== "string" || plan.trim().length === 0) {
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", "ZCode plan approval has no plan content");
  }
  return plan.trim();
}

function planPermissionOptions(request: PermissionRequest): NativePlanApprovalOption[] {
  let hasAllow = false;
  let hasDeny = false;
  const options = request.options.map((option) => {
    if (option.response.decision === "allow") hasAllow = true;
    else if (option.response.decision === "deny") hasDeny = true;
    else {
      throw new AdapterError(
        "NATIVE_PROTOCOL_ERROR",
        `ZCode plan option has unsupported decision: ${option.response.decision}`,
      );
    }
    return {
      optionId: option.optionId,
      name: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
    };
  });
  if (!hasAllow || !hasDeny) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode plan approval must provide both allow and deny options",
    );
  }
  return options;
}

function planUserInputOptions(request: UserInputRequest): {
  readonly question: string;
  readonly options: NativePlanApprovalOption[];
} {
  if (request.questions?.length !== 1 || request.questions[0]?.multiSelect === true) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode plan approval must provide one single-select question",
    );
  }
  const question = request.questions[0]!;
  if (question.options.length === 0) {
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", "ZCode plan approval has no options");
  }
  return {
    question: question.question,
    options: question.options.map((option) => ({
      optionId: option.value,
      name: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
  };
}

function structuredInputContent(question: string, optionId: string): Record<string, unknown> {
  return {
    answer_0: optionId,
    answers: { [question]: [optionId] },
    answer: optionId,
  };
}

function todoEntries(todos: NonNullable<SessionSnapshot["todos"]>): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}> {
  return todos.map((todo) => ({
    content: todo.content,
    status: todo.status,
    priority: todo.priority,
  }));
}

function denyAnswer(request: PermissionRequest): NativePermissionAnswer {
  const option = request.options.find((candidate) => candidate.response.decision === "deny");
  if (option === undefined) {
    throw new AdapterError(
      "NATIVE_PROTOCOL_ERROR",
      "ZCode permission request does not provide a native deny option",
    );
  }
  return { optionId: option.optionId, response: option.response };
}

export function toolKind(
  name: string,
): "read" | "edit" | "delete" | "move" | "search" | "execute" | "fetch" | "think" | "other" {
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

function persistedToolStatus(
  status: string | undefined,
): "pending" | "in_progress" | "completed" | "failed" {
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

function textToolContent(value: unknown): Array<Record<string, unknown>> {
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
): PromptResult["stopReason"] {
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
  value: PromptResult | unknown,
): void {
  if (turn.settled) return;
  turn.settled = true;
  if (turn.cancelTimer !== undefined) clearTimeout(turn.cancelTimer);
  if (action === "resolve") turn.resolve(value as PromptResult);
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

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000;
}
