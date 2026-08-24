import { basename } from "node:path";
import type { Logger } from "../../diagnostics/logger.ts";
import { AdapterError } from "../../domain/errors.ts";
import type {
  AvailableCommand,
  McpServer,
  PermissionRequest,
  PromptContentBlock,
  PromptResult,
  SessionInteraction,
  SessionState,
  SessionUpdate,
  UserInputRequest,
  UserInputResult,
} from "../../domain/session-contract.ts";
import {
  HeadlessZCodeSessionEngine,
  MODE_OPTIONS,
} from "../../domain/session-service.ts";
import type { SessionSettings } from "../../zcode/protocol/v1/host-schemas.ts";
import { ZCODE_ACP_VERSION } from "../../version.ts";

export const PASEO_OPENCODE_SDK_VERSION = "1.14.46";

export interface PaseoEngine {
  newSession(params: { cwd: string; mcpServers: McpServer[] }): Promise<{
    sessionId: string;
    modes?: SessionState["modes"];
    configOptions?: SessionState["configOptions"];
  }>;
  resumeSession(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: McpServer[];
  }): Promise<SessionState>;
  loadSession(
    params: { cwd: string; sessionId: string; mcpServers: McpServer[] },
    interaction: SessionInteraction,
  ): Promise<SessionState>;
  listSessions(params: { cwd: string }): Promise<{
    sessions: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>;
  }>;
  closeSession(params: { sessionId: string }): Promise<void>;
  setSessionMode(params: { sessionId: string; modeId: string }): Promise<void>;
  setSessionConfigOption(params: {
    sessionId: string;
    configId: string;
    value: unknown;
  }): Promise<unknown>;
  prompt(
    params: { sessionId: string; prompt: PromptContentBlock[] },
    interaction: SessionInteraction,
    signal: AbortSignal,
  ): Promise<PromptResult>;
  cancel(params: { sessionId: string }): Promise<void>;
  close(): Promise<void>;
  getWorkspaceSettings(cwd: string): Promise<SessionSettings>;
  getWorkspaceCommands(cwd: string): Promise<AvailableCommand[]>;
  reconfigureSessionMcp(
    cwd: string,
    sessionId: string,
    mcpServers: McpServer[],
  ): Promise<SessionState>;
}

interface ManagedSession {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId?: string;
  modeId?: string;
  variant?: string;
  status: "idle" | "busy";
  mcpRevision: number;
  hasPrompted: boolean;
  messages: OpenCodeMessage[];
  active?: ActiveTurn;
}

interface ActiveTurn {
  userMessageId: string;
  assistantMessageId: string;
  textPartId: string;
  reasoningPartId: string;
  createdAt: number;
  abort: AbortController;
  toolParts: Map<string, Record<string, unknown>>;
}

interface OpenCodeMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

interface PendingQuestion {
  sessionId: string;
  answerMaps: Array<Map<string, string>>;
  resolve: (answers: string[][] | null) => void;
}

interface DirectoryMcpState {
  revision: number;
  servers: Map<string, unknown>;
}

interface ServerOptions {
  port: number;
  logger: Logger;
  engine: PaseoEngine;
}

export interface PaseoOpenCodeServer {
  readonly port: number;
  stop(): Promise<void>;
}

export function createPaseoEngine(
  logger: Logger,
  discoveryOptions: ConstructorParameters<typeof HeadlessZCodeSessionEngine>[1] = {},
): PaseoEngine {
  return new HeadlessZCodeSessionEngine(logger, discoveryOptions);
}

export function startPaseoOpenCodeServer(options: ServerOptions): PaseoOpenCodeServer {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new AdapterError("INVALID_CONFIGURATION", "--port must be an integer from 1 to 65535");
  }
  const facade = new OpenCodeFacade(options.engine, options.logger);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 255,
    fetch: (request) => facade.fetch(request),
  });
  options.logger.log("info", "paseo.opencode.listening", {
    hostname: server.hostname,
    port: server.port,
    sdkVersion: PASEO_OPENCODE_SDK_VERSION,
  });
  return {
    port: server.port ?? options.port,
    async stop() {
      facade.close();
      void server.stop(true);
      await options.engine.close();
    },
  };
}

class OpenCodeFacade {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly mcpByDirectory = new Map<string, DirectoryMcpState>();
  private nextEventId = 1;
  private closed = false;

  constructor(
    private readonly engine: PaseoEngine,
    private readonly logger: Logger,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      this.logger.error("paseo.opencode.request_failed", error, {
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
      const status = error instanceof AdapterError && error.code === "SESSION_NOT_FOUND" ? 404 : 400;
      return json({ name: "OpenCodeCompatibilityError", data: { message: errorMessage(error) } }, status);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.subscribers) controller.close();
    this.subscribers.clear();
    this.rejectPendingQuestions();
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "GET" && path === "/global/health") {
      return json({ healthy: true, version: ZCODE_ACP_VERSION });
    }
    if (method === "GET" && path === "/global/event") return this.eventStream();
    if (method === "GET" && path === "/provider") return await this.providers(url);
    if (method === "GET" && path === "/agent") return json(this.agents());
    if (method === "GET" && path === "/command") return await this.commands(url);
    if (method === "GET" && path === "/experimental/session") return await this.listSessions(url);
    if (method === "POST" && path === "/session") return await this.createSession(request, url);
    if (method === "GET" && path === "/session/status") return json(this.sessionStatuses(url));
    if (method === "POST" && path === "/mcp") return await this.addMcp(request, url);

    const questionReply = path.match(/^\/question\/([^/]+)\/reply$/u);
    if (method === "POST" && questionReply) {
      return await this.replyQuestion(decodeURIComponent(questionReply[1]!), request);
    }
    const questionReject = path.match(/^\/question\/([^/]+)\/reject$/u);
    if (method === "POST" && questionReject) {
      return this.rejectQuestion(decodeURIComponent(questionReject[1]!));
    }

    const sessionPath = path.match(/^\/session\/([^/]+)$/u);
    if (sessionPath) {
      const sessionId = decodeURIComponent(sessionPath[1]!);
      if (method === "GET") return await this.getSession(sessionId, url);
      if (method === "DELETE") return await this.deleteSession(sessionId);
      if (method === "PATCH") return unsupported("ZCode does not support OpenCode archive or update");
    }
    const childrenPath = path.match(/^\/session\/([^/]+)\/children$/u);
    if (method === "GET" && childrenPath) return json([]);
    const messagesPath = path.match(/^\/session\/([^/]+)\/message$/u);
    if (method === "GET" && messagesPath) {
      return await this.getMessages(decodeURIComponent(messagesPath[1]!), url);
    }
    const promptPath = path.match(/^\/session\/([^/]+)\/prompt_async$/u);
    if (method === "POST" && promptPath) {
      return await this.startPrompt(decodeURIComponent(promptPath[1]!), request, url, false);
    }
    const commandPath = path.match(/^\/session\/([^/]+)\/command$/u);
    if (method === "POST" && commandPath) {
      return await this.startPrompt(decodeURIComponent(commandPath[1]!), request, url, true);
    }
    const abortPath = path.match(/^\/session\/([^/]+)\/abort$/u);
    if (method === "POST" && abortPath) {
      await this.cancelSession(decodeURIComponent(abortPath[1]!));
      return json(true);
    }
    if (/^\/session\/[^/]+\/(?:revert|unrevert|summarize)$/u.test(path)) {
      return unsupported("ZCode does not support this OpenCode session operation");
    }
    return json({ name: "NotFoundError", data: { message: `Unsupported route: ${method} ${path}` } }, 404);
  }

  private eventStream(): Response {
    const encoder = new TextEncoder();
    const subscribers = this.subscribers;
    let ownController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source: UnderlyingDefaultSource<Uint8Array> = {
      start: (controller) => {
        ownController = controller;
        subscribers.add(controller);
        controller.enqueue(encoder.encode(sseFrame({
          directory: "",
          payload: { id: this.eventId(), type: "server.connected", properties: {} },
        })));
      },
      cancel: () => {
        if (ownController) subscribers.delete(ownController);
        if (subscribers.size === 0) this.rejectPendingQuestions();
      },
    };
    const stream = new ReadableStream<Uint8Array>(source);
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    });
  }

  private async providers(url: URL): Promise<Response> {
    const cwd = requireDirectory(url);
    const settings = await this.engine.getWorkspaceSettings(cwd);
    const models: Record<string, unknown> = {};
    for (const option of settings.model.available) {
      const id = encodeModelRef(option.ref);
      models[id] = {
        id,
        providerID: "zcode",
        name: option.ref.modelId,
        family: option.providerLabel ?? option.ref.providerId,
        attachment: true,
        reasoning: settings.thoughtLevel.enabled,
        tool_call: true,
        variants: Object.fromEntries(
          settings.thoughtLevel.available.map((thought) => [thought.value, {}]),
        ),
      };
    }
    return json({
      all: [{
        id: "zcode",
        name: "ZCode",
        source: "api",
        env: [],
        options: {},
        models,
      }],
      connected: ["zcode"],
      default: { zcode: encodeModelRef(settings.model.current) },
    });
  }

  private agents(): Array<Record<string, unknown>> {
    return MODE_OPTIONS.map((mode) => ({
      name: mode.id,
      description: mode.description,
      mode: "primary",
      native: true,
      hidden: false,
      permission: [],
      options: {},
    }));
  }

  private async commands(url: URL): Promise<Response> {
    const commands = await this.engine.getWorkspaceCommands(requireDirectory(url));
    return json(commands.map((command) => ({
      name: command.name,
      description: command.description,
      source: "command",
      template: `/${command.name}`,
      hints: command.input?.hint ? [command.input.hint] : [],
    })));
  }

  private async listSessions(url: URL): Promise<Response> {
    const cwd = optionalDirectory(url);
    if (!cwd) {
      return json([...this.sessions.values()].map(sessionInfo));
    }
    const result = await this.engine.listSessions({ cwd });
    return json(result.sessions.map((session) => sessionInfo({
      id: session.sessionId,
      cwd: session.cwd,
      title: session.title ?? "ZCode session",
      createdAt: parseTime(session.updatedAt) ?? Date.now(),
      updatedAt: parseTime(session.updatedAt) ?? Date.now(),
    })));
  }

  private async createSession(request: Request, url: URL): Promise<Response> {
    const cwd = requireDirectory(url);
    const body = await readBody(request);
    const created = await this.engine.newSession({ cwd, mcpServers: [] });
    const now = Date.now();
    const session: ManagedSession = {
      id: created.sessionId,
      cwd,
      title: stringValue(body.title) ?? "ZCode session",
      createdAt: now,
      updatedAt: now,
      status: "idle",
      mcpRevision: 0,
      hasPrompted: false,
      messages: [],
    };
    this.sessions.set(session.id, session);
    await this.applySelections(session, body);
    this.publish(session.cwd, "session.created", {
      sessionID: session.id,
      info: sessionInfo(session),
    });
    return json(sessionInfo(session));
  }

  private sessionStatuses(url: URL): Record<string, unknown> {
    const cwd = optionalDirectory(url);
    return Object.fromEntries(
      [...this.sessions.values()]
        .filter((session) => cwd === null || session.cwd === cwd)
        .map((session) => [session.id, { type: session.status }]),
    );
  }

  private async getSession(sessionId: string, url: URL): Promise<Response> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const cwd = requireDirectory(url);
      const state = await this.engine.resumeSession({ cwd, sessionId, mcpServers: [] });
      const now = Date.now();
      const restored: ManagedSession = {
        id: sessionId,
        cwd,
        title: "ZCode session",
        createdAt: now,
        updatedAt: now,
        ...(state.modes?.currentModeId ? { modeId: state.modes.currentModeId } : {}),
        status: "idle",
        mcpRevision: 0,
        hasPrompted: false,
        messages: [],
      };
      this.sessions.set(sessionId, restored);
      session = restored;
    }
    return json(sessionInfo(session));
  }

  private async deleteSession(sessionId: string): Promise<Response> {
    const session = this.requireSession(sessionId);
    if (session.active) await this.cancelSession(sessionId);
    await this.engine.closeSession({ sessionId });
    this.sessions.delete(sessionId);
    this.publish(session.cwd, "session.deleted", {
      sessionID: session.id,
      info: sessionInfo(session),
    });
    return json(true);
  }

  private async getMessages(sessionId: string, url: URL): Promise<Response> {
    const session = this.sessions.get(sessionId) ?? await this.hydrateSession(sessionId, url);
    if (session.messages.length === 0) {
      const collector = new HistoryCollector(session);
      await this.engine.loadSession(
        { cwd: session.cwd, sessionId, mcpServers: this.currentMcpServers(session.cwd) },
        collector,
      );
      session.messages = collector.messages;
    }
    return json(session.messages);
  }

  private async hydrateSession(sessionId: string, url: URL): Promise<ManagedSession> {
    await this.getSession(sessionId, url);
    return this.requireSession(sessionId);
  }

  private async addMcp(request: Request, url: URL): Promise<Response> {
    const cwd = requireDirectory(url);
    if ([...this.sessions.values()].some((session) => session.cwd === cwd && session.hasPrompted)) {
      return json({
        name: "McpConfigurationLocked",
        data: { message: "MCP configuration cannot change after the first ZCode prompt" },
      }, 409);
    }
    const body = await readBody(request);
    const name = requireString(body.name, "MCP name");
    const state = this.mcpByDirectory.get(cwd) ?? { revision: 0, servers: new Map() };
    state.servers.set(name, body.config);
    state.revision += 1;
    this.mcpByDirectory.set(cwd, state);
    return json(Object.fromEntries([...state.servers.keys()].map((key) => [key, { status: "connected" }])));
  }

  private async startPrompt(
    sessionId: string,
    request: Request,
    url: URL,
    command: boolean,
  ): Promise<Response> {
    const session = this.sessions.get(sessionId) ?? await this.hydrateSession(sessionId, url);
    if (session.active) {
      return json({ name: "SessionBusy", data: { message: "A ZCode turn is already running" } }, 409);
    }
    const body = await readBody(request);
    await this.applyMcp(session);
    await this.applySelections(session, body);
    const prompt = command ? commandPrompt(body) : promptParts(body.parts);
    const now = Date.now();
    const active: ActiveTurn = {
      userMessageId: stringValue(body.messageID) ?? crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      textPartId: crypto.randomUUID(),
      reasoningPartId: crypto.randomUUID(),
      createdAt: now,
      abort: new AbortController(),
      toolParts: new Map(),
    };
    session.active = active;
    session.status = "busy";
    session.hasPrompted = true;
    session.updatedAt = now;
    const userMessage = makeUserMessage(session, active, body, prompt);
    const assistantMessage = makeAssistantMessage(session, active);
    session.messages.push(userMessage, assistantMessage);
    this.publish(session.cwd, "message.updated", { sessionID: session.id, info: userMessage.info });
    this.publish(session.cwd, "message.updated", {
      sessionID: session.id,
      info: assistantMessage.info,
    });
    this.publish(session.cwd, "session.status", {
      sessionID: session.id,
      status: { type: "busy" },
    });
    void this.runPrompt(session, active, prompt, assistantMessage);
    return new Response(null, { status: 204 });
  }

  private async runPrompt(
    session: ManagedSession,
    active: ActiveTurn,
    prompt: PromptContentBlock[],
    assistantMessage: OpenCodeMessage,
  ): Promise<void> {
    try {
      const result = await this.engine.prompt(
        { sessionId: session.id, prompt },
        this.interaction(session, active, assistantMessage),
        active.abort.signal,
      );
      const completedAt = Date.now();
      assistantMessage.info = {
        ...assistantMessage.info,
        time: { created: active.createdAt, completed: completedAt },
        finish: result.stopReason,
        tokens: openCodeTokens(result.usage),
      };
      session.updatedAt = completedAt;
      for (const part of assistantMessage.parts) {
        if (part.type !== "text" && part.type !== "reasoning") continue;
        part.time = { ...record(part.time), end: completedAt };
        this.publish(session.cwd, "message.part.updated", {
          sessionID: session.id,
          part,
          time: completedAt,
        });
      }
      const finishPart = {
        id: crypto.randomUUID(),
        sessionID: session.id,
        messageID: active.assistantMessageId,
        type: "step-finish",
        reason: result.stopReason,
        cost: 0,
        tokens: openCodeTokens(result.usage),
      };
      assistantMessage.parts.push(finishPart);
      this.publish(session.cwd, "message.part.updated", {
        sessionID: session.id,
        part: finishPart,
        time: completedAt,
      });
      this.publish(session.cwd, "message.updated", {
        sessionID: session.id,
        info: assistantMessage.info,
      });
      if (result.stopReason === "cancelled") {
        this.publish(session.cwd, "session.error", {
          sessionID: session.id,
          error: { name: "MessageAbortedError", data: { message: "ZCode turn cancelled" } },
        });
      } else {
        this.publish(session.cwd, "session.idle", { sessionID: session.id });
      }
    } catch (error) {
      this.publish(session.cwd, "session.error", {
        sessionID: session.id,
        error: active.abort.signal.aborted
          ? { name: "MessageAbortedError", data: { message: "ZCode turn cancelled" } }
          : { name: "UnknownError", data: { message: errorMessage(error) } },
      });
    } finally {
      if (session.active === active) delete session.active;
      session.status = "idle";
    }
  }

  private interaction(
    session: ManagedSession,
    active: ActiveTurn,
    assistantMessage: OpenCodeMessage,
  ): SessionInteraction {
    return {
      notify: async (_sessionId, update) => {
        this.mapUpdate(session, active, assistantMessage, update);
      },
      requestPermission: async (request) => await this.askPermission(session, active, request),
      requestUserInput: async (request) => await this.askUserInput(session, active, request),
    };
  }

  private mapUpdate(
    session: ManagedSession,
    active: ActiveTurn,
    assistantMessage: OpenCodeMessage,
    update: SessionUpdate,
  ): void {
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const content = record(update.content);
      const delta = stringValue(content.text);
      if (!delta) return;
      const reasoning = update.sessionUpdate === "agent_thought_chunk";
      const partId = reasoning ? active.reasoningPartId : active.textPartId;
      const type = reasoning ? "reasoning" : "text";
      let part = assistantMessage.parts.find((item) => item.id === partId);
      if (!part) {
        part = {
          id: partId,
          sessionID: session.id,
          messageID: active.assistantMessageId,
          type,
          text: "",
          time: { start: Date.now() },
        };
        assistantMessage.parts.push(part);
        this.publish(session.cwd, "message.part.updated", {
          sessionID: session.id,
          part,
          time: Date.now(),
        });
      }
      part.text = `${stringValue(part.text) ?? ""}${delta}`;
      this.publish(session.cwd, "message.part.delta", {
        sessionID: session.id,
        messageID: active.assistantMessageId,
        partID: partId,
        field: reasoning ? "reasoning" : "text",
        delta,
      });
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const callId = requireString(update.toolCallId, "tool call id");
      const input = record(update.rawInput);
      const part = {
        id: callId,
        sessionID: session.id,
        messageID: active.assistantMessageId,
        type: "tool",
        callID: callId,
        tool: stringValue(update.title) ?? "tool",
        state: { status: "pending", input, raw: JSON.stringify(update.rawInput ?? {}) },
      };
      active.toolParts.set(callId, part);
      assistantMessage.parts.push(part);
      this.publish(session.cwd, "message.part.updated", {
        sessionID: session.id,
        part,
        time: Date.now(),
      });
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const callId = requireString(update.toolCallId, "tool call id");
      const part = active.toolParts.get(callId);
      if (!part) return;
      const previous = record(part.state);
      const status = stringValue(update.status);
      const time = Date.now();
      const previousStart = record(previous.time).start;
      const start = typeof previousStart === "number" && Number.isFinite(previousStart)
        ? previousStart
        : time;
      if (status === "in_progress") {
        part.state = { status: "running", input: record(previous.input), time: { start } };
      } else if (status === "completed") {
        part.state = {
          status: "completed",
          input: record(previous.input),
          output: stringify(update.rawOutput),
          title: stringValue(part.tool) ?? "tool",
          metadata: {},
          time: { start, end: time },
        };
      } else if (status === "failed") {
        part.state = {
          status: "error",
          input: record(previous.input),
          error: stringify(update.rawOutput),
          time: { start, end: time },
        };
      }
      this.publish(session.cwd, "message.part.updated", {
        sessionID: session.id,
        part,
        time,
      });
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      const title = stringValue(update.title);
      if (title) session.title = title;
      this.publish(session.cwd, "session.updated", {
        sessionID: session.id,
        info: sessionInfo(session),
      });
      return;
    }
    if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      this.publish(session.cwd, "todo.updated", {
        sessionID: session.id,
        todos: update.entries,
      });
    }
  }

  private async askPermission(
    session: ManagedSession,
    active: ActiveTurn,
    request: PermissionRequest,
  ): Promise<{ optionId: string } | null> {
    const built = buildQuestionOptions(request.options.map((option) => ({
      value: option.optionId,
      label: option.name,
      description: option.description,
    })));
    const answers = await this.publishQuestion(session, {
      id: request.requestId,
      questions: [{
        question: request.reason || `Allow ${request.toolName}?`,
        header: "Permission",
        options: built.options,
        multiple: false,
        custom: false,
      }],
      tool: { messageID: active.assistantMessageId, callID: request.toolCallId },
    }, [built.answerMap]);
    return answers?.[0]?.[0] ? { optionId: answers[0][0]! } : null;
  }

  private async askUserInput(
    session: ManagedSession,
    active: ActiveTurn,
    request: UserInputRequest,
  ): Promise<UserInputResult> {
    const questions = request.questions ?? [];
    const usedHeaders = new Set<string>();
    const maps: Array<Map<string, string>> = [];
    const openCodeQuestions = questions.map((question, index) => {
      const built = buildQuestionOptions(question.options);
      maps.push(built.answerMap);
      return {
        question: question.question,
        header: uniqueHeader(question.header, index, usedHeaders),
        options: built.options,
        multiple: question.multiSelect === true,
        custom: false,
      };
    });
    const answers = await this.publishQuestion(session, {
      id: request.requestId,
      questions: openCodeQuestions,
      ...(request.toolCallId
        ? { tool: { messageID: active.assistantMessageId, callID: request.toolCallId } }
        : {}),
    }, maps);
    if (answers === null) return { action: "decline" };
    const content: Record<string, unknown> = {};
    const byQuestion: Record<string, string[]> = {};
    for (const [index, question] of questions.entries()) {
      const values = answers[index] ?? [];
      content[`answer_${index}`] = question.multiSelect ? values : values[0];
      byQuestion[question.question] = values;
    }
    content.answers = byQuestion;
    if (questions.length === 1) content.answer = content.answer_0;
    return { action: "accept", content };
  }

  private publishQuestion(
    session: ManagedSession,
    question: { id: string; questions: unknown[]; tool?: unknown },
    answerMaps: Array<Map<string, string>>,
  ): Promise<string[][] | null> {
    if (this.pendingQuestions.has(question.id)) {
      throw new AdapterError("NATIVE_PROTOCOL_ERROR", `Duplicate question request: ${question.id}`);
    }
    const completion = Promise.withResolvers<string[][] | null>();
    this.pendingQuestions.set(question.id, {
      sessionId: session.id,
      answerMaps,
      resolve: completion.resolve,
    });
    this.publish(session.cwd, "question.asked", {
      id: question.id,
      sessionID: session.id,
      questions: question.questions,
      ...(question.tool === undefined ? {} : { tool: question.tool }),
    });
    return completion.promise;
  }

  private async replyQuestion(requestId: string, request: Request): Promise<Response> {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return json({ name: "NotFoundError", data: { message: "Unknown question" } }, 404);
    const body = await readBody(request);
    const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
    const mapped = pending.answerMaps.map((answerMap, index) => {
      const answers = Array.isArray(rawAnswers[index]) ? rawAnswers[index] as unknown[] : [];
      return answers.map((answer) => answerMap.get(String(answer))).filter(isString);
    });
    this.pendingQuestions.delete(requestId);
    pending.resolve(mapped);
    const session = this.requireSession(pending.sessionId);
    this.publish(session.cwd, "question.replied", {
      sessionID: pending.sessionId,
      requestID: requestId,
      answers: rawAnswers,
    });
    return json(true);
  }

  private rejectQuestion(requestId: string): Response {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return json({ name: "NotFoundError", data: { message: "Unknown question" } }, 404);
    this.pendingQuestions.delete(requestId);
    pending.resolve(null);
    const session = this.requireSession(pending.sessionId);
    this.publish(session.cwd, "question.rejected", {
      sessionID: pending.sessionId,
      requestID: requestId,
    });
    return json(true);
  }

  private async applySelections(session: ManagedSession, body: Record<string, unknown>): Promise<void> {
    const agent = stringValue(body.agent);
    if (agent && agent !== session.modeId) {
      await this.engine.setSessionMode({ sessionId: session.id, modeId: agent });
      session.modeId = agent;
    }
    const model = record(body.model);
    const modelId = stringValue(model.modelID) ?? stringValue(body.model);
    if (modelId && modelId !== session.modelId) {
      await this.engine.setSessionConfigOption({
        sessionId: session.id,
        configId: "zcode.model",
        value: decodeModelRef(modelId),
      });
      session.modelId = modelId;
    }
    const variant = stringValue(body.variant);
    if (variant && variant !== "default" && variant !== session.variant) {
      await this.engine.setSessionConfigOption({
        sessionId: session.id,
        configId: "zcode.thought_level",
        value: variant,
      });
      session.variant = variant;
    }
  }

  private async applyMcp(session: ManagedSession): Promise<void> {
    const state = this.mcpByDirectory.get(session.cwd);
    if (!state || state.revision === session.mcpRevision) return;
    await this.engine.reconfigureSessionMcp(
      session.cwd,
      session.id,
      this.currentMcpServers(session.cwd),
    );
    session.mcpRevision = state.revision;
  }

  private async cancelSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    session?.active?.abort.abort();
    this.rejectPendingQuestions(sessionId, true);
    await this.engine.cancel({ sessionId });
  }

  private rejectPendingQuestions(sessionId?: string, publish = false): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      this.pendingQuestions.delete(requestId);
      pending.resolve(null);
      const session = publish ? this.sessions.get(pending.sessionId) : undefined;
      if (session) {
        this.publish(session.cwd, "question.rejected", {
          sessionID: pending.sessionId,
          requestID: requestId,
        });
      }
    }
  }

  private currentMcpServers(cwd: string): McpServer[] {
    const state = this.mcpByDirectory.get(cwd);
    if (!state) return [];
    return [...state.servers.entries()].map(([name, config]) => mapMcpServer(name, config));
  }

  private publish(directory: string, type: string, properties: Record<string, unknown>): void {
    const frame = new TextEncoder().encode(sseFrame({
      directory,
      payload: { id: this.eventId(), type, properties },
    }));
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(frame);
      } catch {
        this.subscribers.delete(controller);
      }
    }
  }

  private eventId(): string {
    const value = `zcode-${this.nextEventId}`;
    this.nextEventId += 1;
    return value;
  }

  private requireSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AdapterError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`);
    return session;
  }
}

class HistoryCollector implements SessionInteraction {
  readonly messages: OpenCodeMessage[] = [];
  private readonly byId = new Map<string, OpenCodeMessage>();
  private readonly toolParts = new Map<string, Record<string, unknown>>();

  constructor(private readonly session: ManagedSession) {}

  async notify(sessionId: string, update: SessionUpdate): Promise<void> {
    const messageId = stringValue(update.messageId) ?? crypto.randomUUID();
    if (update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk") {
      const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      let message = this.byId.get(messageId);
      if (!message) {
        message = role === "user"
          ? makePersistedUserMessage(this.session, messageId)
          : makePersistedAssistantMessage(this.session, messageId);
        this.byId.set(messageId, message);
        this.messages.push(message);
      }
      const content = record(update.content);
      const text = stringValue(content.text);
      if (text) {
        message.parts.push({
          id: crypto.randomUUID(),
          sessionID: sessionId,
          messageID: messageId,
          type: update.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text",
          text,
          time: { start: Date.now(), end: Date.now() },
        });
      }
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      let message = this.messages.findLast((entry) => entry.info.role === "assistant");
      if (!message) {
        message = makePersistedAssistantMessage(this.session, messageId);
        this.messages.push(message);
      }
      const part = {
        id: stringValue(update.toolCallId) ?? crypto.randomUUID(),
        sessionID: sessionId,
        messageID: stringValue(message.info.id) ?? messageId,
        type: "tool",
        callID: stringValue(update.toolCallId) ?? crypto.randomUUID(),
        tool: stringValue(update.title) ?? "tool",
        state: persistedToolState(update),
      };
      message.parts.push(part);
      this.toolParts.set(String(part.callID), part);
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const callId = stringValue(update.toolCallId);
      const part = callId ? this.toolParts.get(callId) : undefined;
      if (part) part.state = persistedToolState(update);
    }
  }

  async requestPermission(): Promise<null> {
    throw new AdapterError("INTERACTION_UNSUPPORTED", "Persisted history requested permission");
  }

  async requestUserInput(): Promise<UserInputResult> {
    throw new AdapterError("INTERACTION_UNSUPPORTED", "Persisted history requested user input");
  }
}

function makeUserMessage(
  session: ManagedSession,
  active: ActiveTurn,
  body: Record<string, unknown>,
  prompt: PromptContentBlock[],
): OpenCodeMessage {
  const model = record(body.model);
  return {
    info: {
      id: active.userMessageId,
      sessionID: session.id,
      role: "user",
      time: { created: active.createdAt },
      agent: session.modeId ?? "build",
      model: {
        providerID: "zcode",
        modelID: stringValue(model.modelID) ?? session.modelId ?? "default",
        ...(session.variant ? { variant: session.variant } : {}),
      },
    },
    parts: prompt.map((part) => openCodeUserPart(session.id, active.userMessageId, part)),
  };
}

function openCodeUserPart(
  sessionId: string,
  messageId: string,
  part: PromptContentBlock,
): Record<string, unknown> {
  const common = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: messageId,
  };
  if (part.type === "text") return { ...common, type: "text", text: part.text };
  if (part.type === "resource_link") {
    return {
      ...common,
      type: "file",
      mime: part.mimeType ?? "application/octet-stream",
      filename: part.name,
      url: part.uri,
    };
  }
  if (part.type === "resource") {
    return {
      ...common,
      type: "file",
      mime: part.resource.mimeType ?? "application/octet-stream",
      filename: basename(part.resource.uri),
      url: part.resource.uri,
    };
  }
  return {
    ...common,
    type: "file",
    mime: part.mimeType,
    url: part.uri ?? `data:${part.mimeType};base64,${part.data}`,
  };
}

function makeAssistantMessage(session: ManagedSession, active: ActiveTurn): OpenCodeMessage {
  return {
    info: {
      id: active.assistantMessageId,
      sessionID: session.id,
      role: "assistant",
      time: { created: active.createdAt },
      parentID: active.userMessageId,
      modelID: session.modelId ?? "default",
      providerID: "zcode",
      mode: session.modeId ?? "build",
      agent: session.modeId ?? "build",
      path: { cwd: session.cwd, root: session.cwd },
      cost: 0,
      tokens: openCodeTokens(),
      ...(session.variant ? { variant: session.variant } : {}),
    },
    parts: [],
  };
}

function makePersistedUserMessage(session: ManagedSession, messageId: string): OpenCodeMessage {
  return {
    info: {
      id: messageId,
      sessionID: session.id,
      role: "user",
      time: { created: Date.now() },
      agent: session.modeId ?? "build",
      model: { providerID: "zcode", modelID: session.modelId ?? "default" },
    },
    parts: [],
  };
}

function makePersistedAssistantMessage(session: ManagedSession, messageId: string): OpenCodeMessage {
  const now = Date.now();
  return {
    info: {
      id: messageId,
      sessionID: session.id,
      role: "assistant",
      time: { created: now, completed: now },
      parentID: "persisted",
      modelID: session.modelId ?? "default",
      providerID: "zcode",
      mode: session.modeId ?? "build",
      agent: session.modeId ?? "build",
      path: { cwd: session.cwd, root: session.cwd },
      cost: 0,
      tokens: openCodeTokens(),
    },
    parts: [],
  };
}

function persistedToolState(update: SessionUpdate): Record<string, unknown> {
  const now = Date.now();
  const status = stringValue(update.status);
  if (status === "completed") {
    return {
      status: "completed",
      input: record(update.rawInput),
      output: stringify(update.rawOutput),
      title: stringValue(update.title) ?? "tool",
      metadata: {},
      time: { start: now, end: now },
    };
  }
  if (status === "failed") {
    return {
      status: "error",
      input: record(update.rawInput),
      error: stringify(update.rawOutput),
      time: { start: now, end: now },
    };
  }
  return { status: "pending", input: record(update.rawInput), raw: stringify(update.rawInput) };
}

function sessionInfo(input: ManagedSession | {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}): Record<string, unknown> {
  return {
    id: input.id,
    slug: input.id,
    projectID: workspaceId(input.cwd),
    directory: input.cwd,
    title: input.title,
    version: ZCODE_ACP_VERSION,
    time: { created: input.createdAt, updated: input.updatedAt },
    ...(input instanceof Object && "modeId" in input && input.modeId
      ? { agent: input.modeId }
      : {}),
  };
}

function openCodeTokens(usage?: PromptResult["usage"]): Record<string, unknown> {
  return {
    total: usage?.totalTokens ?? 0,
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.thoughtTokens ?? 0,
    cache: {
      read: usage?.cachedReadTokens ?? 0,
      write: usage?.cachedWriteTokens ?? 0,
    },
  };
}

function buildQuestionOptions(
  options: Array<{ value: string; label: string; description?: string | undefined }>,
): { options: Array<{ label: string; description: string }>; answerMap: Map<string, string> } {
  const answerMap = new Map<string, string>();
  const used = new Set<string>();
  const output = options.map((option, index) => {
    const base = option.label.replaceAll(",", "，");
    let label = base;
    let suffix = 2;
    while (used.has(label)) {
      label = `${base} (${suffix})`;
      suffix += 1;
    }
    if (!label) label = `Option ${index + 1}`;
    used.add(label);
    answerMap.set(label, option.value);
    return { label, description: option.description ?? "" };
  });
  return { options: output, answerMap };
}

function uniqueHeader(header: string, index: number, used: Set<string>): string {
  const base = header.trim() || `Question ${index + 1}`;
  let result = base;
  let suffix = 2;
  while (used.has(result)) {
    result = `${base} ${suffix}`;
    suffix += 1;
  }
  used.add(result);
  return result;
}

function promptParts(value: unknown): PromptContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): PromptContentBlock[] => {
    const input = record(part);
    if (input.type === "text" && typeof input.text === "string") {
      return [{ type: "text", text: input.text }];
    }
    if (input.type === "file" && typeof input.url === "string") {
      const mimeType = stringValue(input.mime) ?? "application/octet-stream";
      const data = decodeDataUrl(input.url);
      if (data && (mimeType.startsWith("image/") || mimeType.startsWith("audio/"))) {
        return [{
          type: mimeType.startsWith("image/") ? "image" : "audio",
          mimeType,
          data,
          uri: input.url,
        }];
      }
      return [{
        type: "resource_link",
        name: stringValue(input.filename) ?? basename(input.url),
        uri: input.url,
        mimeType,
      }];
    }
    return [];
  });
}

function commandPrompt(body: Record<string, unknown>): PromptContentBlock[] {
  const command = requireString(body.command, "command");
  const args = stringValue(body.arguments)?.trim();
  return [{ type: "text", text: args ? `/${command} ${args}` : `/${command}` }];
}

function mapMcpServer(name: string, value: unknown): McpServer {
  const config = record(value);
  if (config.type === "local") {
    const command = Array.isArray(config.command) ? config.command.filter(isString) : [];
    if (command.length === 0) throw new AdapterError("INVALID_CONFIGURATION", `MCP ${name} has no command`);
    return {
      name,
      command: command[0],
      args: command.slice(1),
      env: Object.entries(record(config.environment)).map(([key, item]) => ({
        name: key,
        value: String(item),
      })),
    };
  }
  if (config.type === "remote") {
    return {
      type: "http",
      name,
      url: requireString(config.url, `MCP ${name} URL`),
      headers: Object.entries(record(config.headers)).map(([key, item]) => ({
        name: key,
        value: String(item),
      })),
    };
  }
  throw new AdapterError("INVALID_CONFIGURATION", `Unsupported MCP transport for ${name}`);
}

function encodeModelRef(ref: { providerId: string; modelId: string; variant?: string }): string {
  return Buffer.from(JSON.stringify([ref.providerId, ref.modelId, ref.variant ?? null]), "utf8")
    .toString("base64url");
}

function decodeModelRef(modelId: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(modelId, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 2 || !parsed.every((item) => item === null || typeof item === "string")) {
      throw new Error("invalid model reference");
    }
    return JSON.stringify(parsed);
  } catch (error) {
    throw new AdapterError(
      "INVALID_CONFIGURATION",
      `Invalid ZCode model ID: ${modelId}`,
      {},
      { cause: error },
    );
  }
}

function requireDirectory(url: URL): string {
  const directory = optionalDirectory(url);
  if (!directory) throw new AdapterError("INVALID_WORKSPACE", "OpenCode request requires directory");
  return directory;
}

function optionalDirectory(url: URL): string | null {
  return url.searchParams.get("directory");
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) return {};
  return record(await request.json());
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function unsupported(message: string): Response {
  return json({ name: "UnsupportedOperationError", data: { message } }, 501);
}

function sseFrame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new AdapterError("INVALID_CONFIGURATION", `${name} is required`);
  return result;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeDataUrl(value: string): string | null {
  const match = value.match(/^data:[^;,]+;base64,(.+)$/su);
  return match?.[1] ?? null;
}

function workspaceId(cwd: string): string {
  return Buffer.from(cwd, "utf8").toString("base64url");
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
