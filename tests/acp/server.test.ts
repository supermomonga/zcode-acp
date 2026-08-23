import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import type { SessionService } from "../../src/acp/v1/session-service.ts";
import { createAcpAgent } from "../../src/acp/v1/server.ts";

describe("ACP v1 server", () => {
  test("initializes honestly and creates a fake-backed session", async () => {
    const service = new FakeSessionService();
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const connection = createAcpAgent(service, new NullLogger()).connect(
      acp.ndJsonStream(output.writable, input.readable),
    );
    const writer = input.writable.getWriter();
    const responses = readLines(output.readable);

    await writer.write(
      encode({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }),
    );
    const initialize = await responses.next();
    expect(initialize.value).toMatchObject({
      jsonrpc: "2.0",
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          auth: { logout: {} },
        },
        authMethods: [],
      },
    });

    await writer.write(
      encode({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: { cwd: "/tmp", mcpServers: [] },
      }),
    );
    const session = await responses.next();
    expect(session.value).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "fake-session" },
    });

    await writer.write(
      encode({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: "fake-session",
          prompt: [{ type: "text", text: "hello" }],
        },
      }),
    );
    expect((await responses.next()).value).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fake response" },
        },
      },
    });
    expect((await responses.next()).value).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn" },
    });

    await writer.write(
      encode({
        jsonrpc: "2.0",
        id: "cancel-me",
        method: "session/prompt",
        params: {
          sessionId: "fake-session",
          prompt: [{ type: "text", text: "wait" }],
        },
      }),
    );
    expect((await responses.next()).value).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "fake-session" },
    });
    await writer.write(
      encode({
        jsonrpc: "2.0",
        method: "$/cancel_request",
        params: { requestId: "cancel-me" },
      }),
    );
    expect((await responses.next()).value).toEqual({
      jsonrpc: "2.0",
      id: "cancel-me",
      result: { stopReason: "cancelled" },
    });

    await writer.close();
    await connection.closed;
  });
});

class FakeSessionService implements SessionService {
  async initialize(_params: acp.InitializeRequest): Promise<void> {}

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return { sessionId: "fake-session" };
  }

  async loadSession(
    _params: acp.LoadSessionRequest,
    _context: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> { return {}; }

  async resumeSession(_params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    return {};
  }

  async listSessions(_params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: [] };
  }

  async closeSession(_params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    return {};
  }

  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return {};
  }

  async setSessionConfigOption(
    _params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> { return { configOptions: [] }; }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async logout(_params: acp.LogoutRequest): Promise<acp.LogoutResponse> { return {}; }

  async prompt(
    params: acp.PromptRequest,
    context: acp.AgentContext,
    _signal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    if (params.prompt.some((block) => block.type === "text" && block.text === "wait")) {
      const cancelled = new Promise<acp.PromptResponse>((resolve) => {
        _signal.addEventListener("abort", () => resolve({ stopReason: "cancelled" }), { once: true });
      });
      await context.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "waiting" },
        },
      });
      return await cancelled;
    }
    await context.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fake response" },
      },
    });
    return { stopReason: "end_turn" };
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {}

  async close(): Promise<void> {}
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) {
          yield JSON.parse(line) as unknown;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
