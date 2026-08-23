import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { realpath } from "node:fs/promises";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import type {
  McpServer,
  PermissionRequest,
  PromptContentBlock,
  PromptResult,
  SessionInteraction,
  SessionState,
  UserInputRequest,
  UserInputResult,
} from "../../src/domain/session-contract.ts";
import {
  PASEO_OPENCODE_SDK_VERSION,
  startPaseoOpenCodeServer,
  type PaseoEngine,
  type PaseoOpenCodeServer,
} from "../../src/paseo/opencode/server.ts";
import type { SessionSettings } from "../../src/zcode/protocol/v1/host-schemas.ts";

describe("Paseo OpenCode 1.14.46 facade", () => {
  let server: PaseoOpenCodeServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  test("maps catalog, modes, MCP, streaming, questions, permissions, history, and delete", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine();
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const client = createOpencodeClient({ baseUrl, directory: cwd });

    const health = await client.global.health();
    expect(health.data).toMatchObject({ healthy: true });
    expect(PASEO_OPENCODE_SDK_VERSION).toBe("1.14.46");

    const providerResult = await client.provider.list({ directory: cwd });
    expect(providerResult.error).toBeUndefined();
    expect(providerResult.data?.connected).toEqual(["zcode"]);
    expect(Object.values(providerResult.data?.all[0]?.models ?? {})[0]).toMatchObject({
      name: "GLM-5.2",
      attachment: true,
      tool_call: true,
    });

    const agents = await client.app.agents({ directory: cwd });
    expect(agents.data?.map((agent) => agent.name)).toEqual([
      "build",
      "edit",
      "plan",
      "auto",
      "yolo",
    ]);

    const eventAbort = new AbortController();
    const events = await client.global.event({
      sseMaxRetryAttempts: 0,
      signal: eventAbort.signal,
    });
    const iterator = events.stream[Symbol.asyncIterator]();
    expect(((await iterator.next()).value as { payload: { type: string } }).payload.type)
      .toBe("server.connected");

    const created = await client.session.create({ directory: cwd });
    expect(created.error).toBeUndefined();
    const sessionId = created.data!.id;

    const mcp = await client.mcp.add({
      directory: cwd,
      name: "local-tools",
      config: {
        type: "local",
        command: ["/usr/bin/env", "node", "server.js"],
        environment: { MODE: "test" },
      },
    });
    expect(mcp.data).toEqual({ "local-tools": { status: "connected" } });

    const prompt = await client.session.promptAsync({
      sessionID: sessionId,
      directory: cwd,
      messageID: "user-1",
      model: { providerID: "zcode", modelID: engine.encodedModelId },
      agent: "plan",
      variant: "high",
      parts: [{ type: "text", text: "inspect" }],
    });
    expect(prompt.error).toBeUndefined();

    const observedTypes: string[] = [];
    let finishTokens: unknown;
    for (let count = 0; count < 80; count += 1) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value.payload;
      observedTypes.push(event.type);
      if (event.type === "message.part.updated" && event.properties.part.type === "step-finish") {
        finishTokens = event.properties.part.tokens;
      }
      if (event.type === "question.asked") {
        const question = event.properties;
        if (question.questions.length === 2) {
          expect(question.questions[0]?.header).toBe("Choice");
          expect(question.questions[1]?.header).toBe("Choice 2");
          expect(question.questions[1]?.options[0]?.label).toBe("One，Two");
          await client.question.reply({
            requestID: question.id,
            directory: cwd,
            answers: [["A"], ["One，Two", "Three"]],
          });
        } else {
          expect(question.questions[0]?.header).toBe("Permission");
          await client.question.reply({
            requestID: question.id,
            directory: cwd,
            answers: [["Allow once"]],
          });
        }
      }
      if (event.type === "session.idle") break;
    }

    expect(observedTypes).toContain("message.part.delta");
    expect(observedTypes).toContain("message.part.updated");
    expect(observedTypes).toContain("question.asked");
    expect(observedTypes.at(-1)).toBe("session.idle");
    expect(finishTokens).toEqual({
      total: 12,
      input: 5,
      output: 4,
      reasoning: 3,
      cache: { read: 0, write: 0 },
    });
    expect(engine.userInputResult).toEqual({
      action: "accept",
      content: {
        answer_0: "a",
        answer_1: ["one,two", "three"],
        answers: {
          "Pick one": ["a"],
          "Pick many": ["one,two", "three"],
        },
      },
    });
    expect(engine.permissionSelection).toEqual({ optionId: "allow-once" });
    expect(engine.reconfiguredMcp).toEqual([{
      name: "local-tools",
      command: "/usr/bin/env",
      args: ["node", "server.js"],
      env: [{ name: "MODE", value: "test" }],
    }]);
    expect(engine.selectedMode).toBe("plan");
    expect(engine.selectedThought).toBe("high");

    const messages = await client.session.messages({ sessionID: sessionId, directory: cwd });
    expect(messages.data).toHaveLength(2);
    expect(messages.data?.[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "inspect" }),
    ]);
    expect(messages.data?.[1]?.parts.some((part) => part.type === "tool")).toBe(true);

    const statuses = await client.session.status({ directory: cwd });
    expect(statuses.data?.[sessionId]).toEqual({ type: "idle" });

    const rewind = await fetch(`${baseUrl}/session/${sessionId}/revert?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: JSON.stringify({ messageID: "user-1" }),
      headers: { "content-type": "application/json" },
    });
    expect(rewind.status).toBe(501);

    const deleted = await client.session.delete({ sessionID: sessionId, directory: cwd });
    expect(deleted.data).toBe(true);
    expect(engine.closedSessions).toEqual([sessionId]);
    eventAbort.abort();
  });

  test("rejects MCP mutation after the first prompt", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine();
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const client = createOpencodeClient({ baseUrl, directory: cwd });
    const created = await client.session.create({ directory: cwd });
    await client.session.promptAsync({
      sessionID: created.data!.id,
      directory: cwd,
      parts: [{ type: "text", text: "inspect" }],
    });
    const response = await fetch(`${baseUrl}/mcp?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "late", config: { type: "local", command: ["tool"] } }),
    });
    expect(response.status).toBe(409);
  });

  test("maps question rejection exactly once and completes the turn", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine("reject");
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: cwd,
    });
    const eventAbort = new AbortController();
    const events = await client.global.event({ sseMaxRetryAttempts: 0, signal: eventAbort.signal });
    const iterator = events.stream[Symbol.asyncIterator]();
    await iterator.next();
    const created = await client.session.create({ directory: cwd });
    await client.session.promptAsync({
      sessionID: created.data!.id,
      directory: cwd,
      parts: [{ type: "text", text: "reject" }],
    });

    let questionId = "";
    for (let count = 0; count < 30; count += 1) {
      const event = ((await iterator.next()).value as {
        payload: { type: string; properties: { id: string } };
      }).payload;
      if (event.type === "question.asked") {
        questionId = event.properties.id;
        const rejected = await client.question.reject({ requestID: questionId, directory: cwd });
        expect(rejected.data).toBe(true);
      }
      if (event.type === "session.idle") break;
    }
    expect(questionId).toBe("question-1");
    expect(engine.userInputResult).toEqual({ action: "decline" });
    const duplicate = await client.question.reject({ requestID: questionId, directory: cwd });
    expect(duplicate.error).toBeDefined();
    eventAbort.abort();
  });

  test("declines a pending interaction when the last event subscriber disconnects", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine("reject");
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: cwd,
    });
    const eventAbort = new AbortController();
    const events = await client.global.event({ sseMaxRetryAttempts: 0, signal: eventAbort.signal });
    const iterator = events.stream[Symbol.asyncIterator]();
    await iterator.next();
    const created = await client.session.create({ directory: cwd });
    await client.session.promptAsync({
      sessionID: created.data!.id,
      directory: cwd,
      parts: [{ type: "text", text: "disconnect" }],
    });
    for (let count = 0; count < 30; count += 1) {
      const event = ((await iterator.next()).value as { payload: { type: string } }).payload;
      if (event.type !== "question.asked") continue;
      eventAbort.abort();
      await iterator.return?.(undefined as never);
      break;
    }
    for (let count = 0; count < 30 && engine.userInputResult === undefined; count += 1) {
      await Bun.sleep(10);
    }
    expect(engine.userInputResult).toEqual({ action: "decline" });
  });

  test("aborts an active prompt and releases pending interaction", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine("wait-cancel");
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: cwd,
    });
    const eventAbort = new AbortController();
    const events = await client.global.event({ sseMaxRetryAttempts: 0, signal: eventAbort.signal });
    const iterator = events.stream[Symbol.asyncIterator]();
    await iterator.next();
    const created = await client.session.create({ directory: cwd });
    const sessionId = created.data!.id;
    await client.session.promptAsync({
      sessionID: sessionId,
      directory: cwd,
      parts: [{ type: "text", text: "wait" }],
    });

    let asked = false;
    let cancelled = false;
    for (let count = 0; count < 30; count += 1) {
      const event = ((await iterator.next()).value as {
        payload: { type: string; properties: Record<string, unknown> };
      }).payload;
      if (event.type === "question.asked") {
        asked = true;
        const aborted = await client.session.abort({ sessionID: sessionId, directory: cwd });
        expect(aborted.data).toBe(true);
      }
      if (event.type === "session.error") {
        cancelled = event.properties.error instanceof Object &&
          "name" in event.properties.error &&
          event.properties.error.name === "MessageAbortedError";
        break;
      }
    }
    expect(asked).toBe(true);
    expect(cancelled).toBe(true);
    expect(engine.userInputResult).toEqual({ action: "decline" });
    expect(engine.promptSignalAborted).toBe(true);
    expect(engine.cancelCalls).toBeGreaterThanOrEqual(1);
    eventAbort.abort();
  });

  test("hydrates native history when a persisted session is resumed", async () => {
    const cwd = await realpath(process.cwd());
    const engine = new FakePaseoEngine("history");
    server = startPaseoOpenCodeServer({
      port: await availablePort(),
      logger: new NullLogger(),
      engine,
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${server.port}`,
      directory: cwd,
    });

    const resumed = await client.session.get({ sessionID: "native-existing", directory: cwd });
    expect(resumed.data?.id).toBe("native-existing");
    const messages = await client.session.messages({ sessionID: "native-existing", directory: cwd });
    expect(engine.resumedSessionId).toBe("native-existing");
    expect(messages.data).toHaveLength(2);
    expect(messages.data?.[0]?.parts[0]).toMatchObject({ type: "text", text: "saved prompt" });
    expect(messages.data?.[1]?.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "saved answer" }),
      expect.objectContaining({
        type: "tool",
        state: expect.objectContaining({ status: "completed", output: "saved contents" }),
      }),
    ]));
  });
});

class FakePaseoEngine implements PaseoEngine {
  readonly encodedModelId = Buffer.from(
    JSON.stringify(["builtin:zai-coding-plan", "GLM-5.2", null]),
    "utf8",
  ).toString("base64url");
  readonly closedSessions: string[] = [];
  userInputResult?: UserInputResult;
  permissionSelection?: { optionId: string } | null;
  reconfiguredMcp?: McpServer[];
  selectedMode?: string;
  selectedThought?: unknown;
  resumedSessionId?: string;
  promptSignalAborted = false;
  cancelCalls = 0;
  private nextSession = 1;

  constructor(private readonly behavior: "full" | "reject" | "wait-cancel" | "history" = "full") {}

  async getWorkspaceSettings(): Promise<SessionSettings> {
    return settings();
  }

  async getWorkspaceCommands() {
    return [{ name: "review", description: "Review changes", input: { hint: "path" } }];
  }

  async newSession() {
    return {
      sessionId: `session-${this.nextSession++}`,
      modes: { currentModeId: "build", availableModes: [] },
      configOptions: [],
    };
  }

  async resumeSession(params: { sessionId: string }): Promise<SessionState> {
    this.resumedSessionId = params.sessionId;
    return { modes: { currentModeId: "build", availableModes: [] } };
  }

  async loadSession(
    params: { sessionId: string },
    interaction: SessionInteraction,
  ): Promise<SessionState> {
    if (this.behavior === "history") {
      await interaction.notify(params.sessionId, {
        sessionUpdate: "user_message_chunk",
        messageId: "persisted-user",
        content: { type: "text", text: "saved prompt" },
      });
      await interaction.notify(params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: "persisted-assistant",
        content: { type: "text", text: "saved answer" },
      });
      await interaction.notify(params.sessionId, {
        sessionUpdate: "tool_call",
        messageId: "persisted-assistant",
        toolCallId: "persisted-tool",
        title: "read_file",
        rawInput: { path: "README.md" },
      });
      await interaction.notify(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "persisted-tool",
        status: "completed",
        rawOutput: "saved contents",
      });
    }
    return {};
  }

  async listSessions() {
    return { sessions: [] };
  }

  async closeSession(params: { sessionId: string }): Promise<void> {
    this.closedSessions.push(params.sessionId);
  }

  async setSessionMode(params: { modeId: string }): Promise<void> {
    this.selectedMode = params.modeId;
  }

  async setSessionConfigOption(params: { configId: string; value: unknown }): Promise<void> {
    if (params.configId === "zcode.thought_level") this.selectedThought = params.value;
  }

  async reconfigureSessionMcp(_cwd: string, _sessionId: string, servers: McpServer[]) {
    this.reconfiguredMcp = servers;
    return {};
  }

  async prompt(
    params: { prompt: PromptContentBlock[] },
    interaction: SessionInteraction,
    signal: AbortSignal,
  ): Promise<PromptResult> {
    if (this.behavior === "reject" || this.behavior === "wait-cancel") {
      this.userInputResult = await interaction.requestUserInput(userInputRequest());
      if (this.behavior === "wait-cancel") {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        this.promptSignalAborted = signal.aborted;
        return { stopReason: "cancelled" };
      }
      return { stopReason: "end_turn" };
    }
    expect(params.prompt).toEqual([{ type: "text", text: "inspect" }]);
    await interaction.notify("session-1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
    await interaction.notify("session-1", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    });
    this.userInputResult = await interaction.requestUserInput(userInputRequest());
    this.permissionSelection = await interaction.requestPermission(permissionRequest());
    await interaction.notify("session-1", {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read_file",
      rawInput: { path: "README.md" },
    });
    await interaction.notify("session-1", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: "contents",
    });
    return {
      stopReason: "end_turn",
      usage: {
        totalTokens: 12,
        inputTokens: 5,
        outputTokens: 4,
        thoughtTokens: 3,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    };
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
  }
  async close(): Promise<void> {}
}

function settings(): SessionSettings {
  return {
    model: {
      current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
      available: [{
        ref: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
        label: "GLM-5.2",
        providerLabel: "Z.ai - Coding Plan",
      }],
    },
    thoughtLevel: {
      enabled: true,
      current: "high",
      available: [{ value: "high", label: "High" }],
    },
    mode: { current: "build" },
  };
}

function userInputRequest(): UserInputRequest {
  return {
    requestId: "question-1",
    sessionId: "session-1",
    prompt: "Choose",
    questions: [
      {
        question: "Pick one",
        header: "Choice",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      {
        question: "Pick many",
        header: "Choice",
        multiSelect: true,
        options: [
          { value: "one,two", label: "One,Two" },
          { value: "three", label: "Three" },
        ],
      },
    ],
  };
}

function permissionRequest(): PermissionRequest {
  return {
    requestId: "permission-1",
    sessionId: "session-1",
    toolCallId: "tool-1",
    toolName: "read_file",
    reason: "Read README?",
    riskLevel: "low",
    input: { path: "README.md" },
    options: [
      {
        optionId: "allow-once",
        kind: "allow",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "deny-once",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny" },
      },
    ],
  };
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return port;
}
