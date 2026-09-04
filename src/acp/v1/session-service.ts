import type * as acp from "@agentclientprotocol/sdk";
import type { Logger } from "../../diagnostics/logger.ts";
import { AdapterError } from "../../domain/errors.ts";
import type {
  PlanApprovalRequest,
  PermissionRequest,
  SessionEngine,
  SessionInteraction,
  UserInputRequest,
} from "../../domain/session-contract.ts";
import {
  HeadlessZCodeSessionEngine,
  permissionKind,
  toolKind,
} from "../../domain/session-service.ts";
import type { DiscoveryOptions } from "../../zcode/discovery/discover.ts";

const AUTH_METHOD_ID = "zcode-cli";

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

export class HeadlessZCodeSessionService implements SessionService {
  private formElicitationSupported = false;
  private planOperationsSupported = false;

  constructor(
    private readonly engine: SessionEngine,
  ) {}

  static create(logger: Logger, discoveryOptions: DiscoveryOptions = {}): HeadlessZCodeSessionService {
    return new HeadlessZCodeSessionService(
      new HeadlessZCodeSessionEngine(logger, discoveryOptions),
    );
  }

  async initialize(params: acp.InitializeRequest): Promise<void> {
    this.formElicitationSupported = params.clientCapabilities?.elicitation?.form != null;
    this.planOperationsSupported = params.clientCapabilities?.plan != null;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return await this.engine.newSession(params);
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    context: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    return await this.engine.loadSession(params, this.interaction(context));
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    return await this.engine.resumeSession(params);
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return await this.engine.listSessions(params);
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    await this.engine.closeSession(params);
    return {};
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionModeResponse> {
    await this.engine.setSessionMode(params, context ? this.interaction(context) : undefined);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
    context?: acp.AgentContext,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    return await this.engine.setSessionConfigOption(
      params,
      context ? this.interaction(context) : undefined,
    );
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== AUTH_METHOD_ID) {
      throw new AdapterError("INVALID_CONFIGURATION", `Unknown auth method: ${params.methodId}`);
    }
    await this.engine.authenticate();
    return {};
  }

  async logout(_params: acp.LogoutRequest): Promise<acp.LogoutResponse> {
    await this.engine.logout();
    return {};
  }

  async prompt(
    params: acp.PromptRequest,
    context: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    return await this.engine.prompt(params, this.interaction(context), signal);
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    await this.engine.cancel(params);
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  private interaction(context: acp.AgentContext): SessionInteraction {
    return {
      planOperationsSupported: this.planOperationsSupported,
      notify: async (sessionId, update) => {
        await context.notify("session/update", {
          sessionId,
          update: update as acp.SessionNotification["update"],
        });
      },
      requestPermission: async (request) => await requestPermission(context, request),
      requestPlanApproval: async (request) => {
        if (!this.formElicitationSupported) {
          throw new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "ZCode requested plan approval but the ACP client cannot render form elicitation",
          );
        }
        return await requestPlanApproval(context, request);
      },
      requestUserInput: async (request) => {
        if (!this.formElicitationSupported) {
          throw new AdapterError(
            "INTERACTION_UNSUPPORTED",
            "ZCode requested structured input but the ACP client cannot render form elicitation",
          );
        }
        return await requestUserInput(context, request);
      },
    };
  }
}

async function requestPlanApproval(
  context: acp.AgentContext,
  request: PlanApprovalRequest,
): Promise<
  { action: "accept"; optionId: string } | { action: "decline" | "cancel" }
> {
  const result = await context.request<
    acp.CreateElicitationResponse,
    acp.CreateElicitationRequest
  >("elicitation/create", {
    mode: "form",
    sessionId: request.sessionId,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    message: request.message,
    requestedSchema: {
      type: "object",
      properties: {
        optionId: {
          type: "string",
          title: "Plan approval",
          description: request.message,
          oneOf: request.options.map((option) => ({
            const: option.optionId,
            title: option.name,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        },
      },
      required: ["optionId"],
    },
  });
  if (result.action === "decline" || result.action === "cancel") {
    return { action: result.action };
  }
  if (result.action !== "accept") {
    throw new AdapterError(
      "INTERACTION_UNSUPPORTED",
      `Unsupported ACP elicitation action: ${String(result.action)}`,
    );
  }
  const optionId = (result.content as Record<string, unknown> | undefined)?.optionId;
  if (typeof optionId !== "string") {
    throw new AdapterError("NATIVE_PROTOCOL_ERROR", "Plan approval did not select an option");
  }
  return { action: "accept", optionId };
}

async function requestPermission(
  context: acp.AgentContext,
  request: PermissionRequest,
): Promise<{ optionId: string } | null> {
  const options = request.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: permissionKind(option.response),
  } satisfies acp.PermissionOption));
  const result = await context.request<
    acp.RequestPermissionResponse,
    acp.RequestPermissionRequest
  >("session/request_permission", {
    sessionId: request.sessionId,
    toolCall: {
      toolCallId: request.toolCallId,
      title: request.reason || request.toolName,
      kind: toolKind(request.toolName),
      rawInput: request.input,
    },
    options,
  });
  return result.outcome.outcome === "selected"
    ? { optionId: result.outcome.optionId }
    : null;
}

async function requestUserInput(
  context: acp.AgentContext,
  request: UserInputRequest,
): Promise<{ action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" }> {
  const questions = request.questions ?? [];
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  for (const [index, question] of questions.entries()) {
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
  const result = await context.request<
    acp.CreateElicitationResponse,
    acp.CreateElicitationRequest
  >("elicitation/create", {
    mode: "form",
    sessionId: request.sessionId,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    message: request.prompt ?? "ZCode needs additional input",
    requestedSchema: {
      type: "object",
      properties,
      required: Object.keys(properties),
    },
  });
  if (result.action !== "accept") {
    if (result.action === "decline" || result.action === "cancel") {
      return { action: result.action };
    }
    throw new AdapterError(
      "INTERACTION_UNSUPPORTED",
      `Unsupported ACP elicitation action: ${String(result.action)}`,
    );
  }
  const content = (result.content ?? {}) as Record<string, acp.ElicitationContentValue>;
  const answers = Object.fromEntries(questions.map((question, index) => {
    const value = content[`answer_${index}`];
    return [
      question.question,
      Array.isArray(value) ? value : value === undefined ? [] : [String(value)],
    ];
  }));
  return {
    action: "accept",
    content: {
      ...content,
      answers,
      ...(questions.length === 1 ? { answer: content.answer_0 } : {}),
    },
  };
}
