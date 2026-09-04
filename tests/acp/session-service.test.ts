import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { HeadlessZCodeSessionService } from "../../src/acp/v1/session-service.ts";
import type {
  PromptResult,
  SessionEngine,
  SessionInteraction,
} from "../../src/domain/session-contract.ts";

describe("ACP v1 session interaction", () => {
  test("negotiates plan operations independently and sends plan approval as form elicitation", async () => {
    let interaction: SessionInteraction | undefined;
    const service = new HeadlessZCodeSessionService(promptEngine((value) => {
      interaction = value;
    }));
    await service.initialize({
      protocolVersion: 1,
      clientCapabilities: { plan: {}, elicitation: { form: {} } },
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const context = fakeContext(async (method, params) => {
      requests.push({ method, params });
      return { action: "accept", content: { optionId: "approve" } };
    });

    await service.prompt(promptRequest(), context, new AbortController().signal);
    expect(interaction?.planOperationsSupported).toBe(true);
    await expect(interaction?.requestPlanApproval({
      sessionId: "session-1",
      toolCallId: "tool-1",
      message: "Review the plan",
      options: [{ optionId: "approve", name: "Approve", description: "Start implementation" }],
    })).resolves.toEqual({ action: "accept", optionId: "approve" });
    expect(requests).toEqual([{
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId: "session-1",
        toolCallId: "tool-1",
        message: "Review the plan",
        requestedSchema: {
          type: "object",
          properties: {
            optionId: {
              type: "string",
              title: "Plan approval",
              description: "Review the plan",
              oneOf: [{
                const: "approve",
                title: "Approve",
                description: "Start implementation",
              }],
            },
          },
          required: ["optionId"],
        },
      },
    }]);
  });

  test("treats omitted plan capability and omitted form capability separately", async () => {
    let interaction: SessionInteraction | undefined;
    const service = new HeadlessZCodeSessionService(promptEngine((value) => {
      interaction = value;
    }));
    await service.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: null } });
    const context = fakeContext(async () => {
      throw new Error("No ACP request should be sent");
    });

    await service.prompt(promptRequest(), context, new AbortController().signal);
    expect(interaction?.planOperationsSupported).toBe(false);
    await expect(interaction?.requestPlanApproval({
      sessionId: "session-1",
      message: "Review the plan",
      options: [{ optionId: "approve", name: "Approve" }],
    })).rejects.toMatchObject({ code: "INTERACTION_UNSUPPORTED" });
  });

  test("keeps ordinary permission requests on session/request_permission", async () => {
    let interaction: SessionInteraction | undefined;
    const service = new HeadlessZCodeSessionService(promptEngine((value) => {
      interaction = value;
    }));
    await service.initialize({
      protocolVersion: 1,
      clientCapabilities: { plan: {}, elicitation: { form: {} } },
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const context = fakeContext(async (method, params) => {
      requests.push({ method, params });
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    await service.prompt(promptRequest(), context, new AbortController().signal);

    await expect(interaction?.requestPermission({
      requestId: "permission-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "Bash",
      reason: "Run tests",
      riskLevel: "low",
      input: { command: "bun test" },
      options: [{
        optionId: "allow",
        kind: "allow_once",
        name: "Allow",
        response: { decision: "allow" },
      }],
    })).resolves.toEqual({ optionId: "allow" });
    expect(requests[0]).toMatchObject({
      method: "session/request_permission",
      params: { toolCall: { toolCallId: "tool-1", rawInput: { command: "bun test" } } },
    });
  });

  test("keeps ordinary structured questions on form elicitation", async () => {
    let interaction: SessionInteraction | undefined;
    const service = new HeadlessZCodeSessionService(promptEngine((value) => {
      interaction = value;
    }));
    await service.initialize({
      protocolVersion: 1,
      clientCapabilities: { elicitation: { form: {} } },
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const context = fakeContext(async (method, params) => {
      requests.push({ method, params });
      return { action: "accept", content: { answer_0: "fast" } };
    });
    await service.prompt(promptRequest(), context, new AbortController().signal);

    await expect(interaction?.requestUserInput({
      requestId: "input-1",
      sessionId: "session-1",
      prompt: "Choose a mode",
      questions: [{
        question: "Which mode?",
        header: "Mode",
        options: [{ value: "fast", label: "Fast" }],
      }],
    })).resolves.toEqual({
      action: "accept",
      content: {
        answer_0: "fast",
        answer: "fast",
        answers: { "Which mode?": ["fast"] },
      },
    });
    expect(requests[0]).toMatchObject({
      method: "elicitation/create",
      params: {
        mode: "form",
        requestedSchema: {
          required: ["answer_0"],
          properties: { answer_0: { type: "string" } },
        },
      },
    });
  });
});

function promptEngine(capture: (interaction: SessionInteraction) => void): SessionEngine {
  return {
    async prompt(
      _params: Parameters<SessionEngine["prompt"]>[0],
      interaction: SessionInteraction,
    ): Promise<PromptResult> {
      capture(interaction);
      return { stopReason: "end_turn" };
    },
  } as unknown as SessionEngine;
}

function promptRequest(): acp.PromptRequest {
  return { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] };
}

function fakeContext(
  request: (method: string, params: unknown) => Promise<unknown>,
): acp.AgentContext {
  return {
    request,
    async notify() {},
  } as unknown as acp.AgentContext;
}
