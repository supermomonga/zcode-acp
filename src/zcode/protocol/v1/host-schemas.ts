import { z } from "zod";

const RecordSchema = z.record(z.string(), z.unknown());

export const InitializeResultSchema = z
  .object({
    available: z.boolean(),
    workspaceKey: z.string().min(1).optional(),
    protocolName: z.string().optional(),
    protocolVersion: z.number().int().optional(),
    transportKind: z.string().optional(),
    reason: z.string().optional(),
    reasonCode: z.string().optional(),
  })
  .passthrough();

const ModelRefSchema = z
  .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
  .passthrough();

const ModelOptionSchema = z
  .object({
    ref: ModelRefSchema,
    label: z.string().min(1),
    providerLabel: z.string().optional(),
  })
  .passthrough();

const ThoughtLevelOptionSchema = z
  .object({ value: z.string().min(1), label: z.string().min(1) })
  .passthrough();

export const SessionSettingsSchema = z
  .object({
    model: z.object({ current: ModelRefSchema, available: z.array(ModelOptionSchema) }).passthrough(),
    thoughtLevel: z
      .object({
        enabled: z.boolean(),
        current: z.string().optional(),
        available: z.array(ThoughtLevelOptionSchema),
      })
      .passthrough(),
    mode: z.object({ current: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export const WorkspaceStateResultSchema = z
  .object({
    workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
    settings: SessionSettingsSchema,
    modelCatalog: z
      .object({ providers: z.array(z.unknown()), available: z.array(z.unknown()) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const SessionSnapshotSchema = z
  .object({
    session: z
      .object({
        sessionId: z.string().min(1),
        status: z.string(),
        workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
        title: z.string().optional(),
        updatedAt: z.number().optional(),
      })
      .passthrough(),
    settings: SessionSettingsSchema,
    messages: z.array(
      z.object({
        info: z.object({
          messageId: z.string().min(1),
          role: z.enum(["user", "assistant"]),
        }).passthrough(),
        parts: z.array(z.object({ type: z.string().min(1) }).passthrough()),
      }).passthrough(),
    ),
    runtime: z.object({
      contextUsage: z.object({
        used: z.number().int().nonnegative(),
        size: z.number().int().positive(),
        cost: z.object({ amount: z.number().nonnegative(), currency: z.string().min(1) }).nullable().optional(),
      }).passthrough().optional(),
    }).passthrough(),
    todos: z.array(z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      priority: z.enum(["high", "medium", "low"]),
    }).strict()).optional(),
    slashCommands: z.array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
        inputHint: z.string().optional(),
      }).passthrough(),
    ),
  })
  .passthrough();

export const SessionListSchema = z.array(
  z.object({
    sessionId: z.string().min(1),
    workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
    title: z.string().optional(),
    updatedAt: z.number().optional(),
  }).passthrough(),
);

export const SendPromptResultSchema = z
  .object({ sessionId: z.string().min(1), accepted: z.literal(true) })
  .passthrough();

export const TokenUsageSchema = z.object({
  sessionId: z.string().min(1),
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
}).passthrough();

export const BooleanResultSchema = z.boolean();
export const UnknownResultSchema = z.unknown();

const PermissionResponseSchema = z
  .object({
    decision: z.enum(["allow", "deny", "escalate", "modify"]),
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(z.unknown()).optional(),
  })
  .strict();

const PermissionOptionSchema = z
  .object({
    optionId: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    response: PermissionResponseSchema,
  })
  .strict();

export const PermissionRequestSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().optional(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    reason: z.string(),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    input: z.unknown(),
    origin: z.unknown().optional(),
    options: z.array(PermissionOptionSchema).min(1),
  })
  .strict();

const UserQuestionSchema = z
  .object({
    question: z.string().min(1),
    header: z.string().min(1),
    options: z.array(
      z
        .object({
          value: z.string(),
          label: z.string(),
          description: z.string().optional(),
          preview: z.string().optional(),
        })
        .strict(),
    ),
    multiSelect: z.boolean().optional(),
  })
  .strict();

export const UserInputRequestSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    prompt: z.string().optional(),
    questions: z.array(UserQuestionSchema).optional(),
    input: z.unknown().optional(),
    origin: z.unknown().optional(),
    schema: z.unknown().optional(),
  })
  .strict();

export const ProviderRuntimeHeadersRequestSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().optional(),
    workspace: z.object({ workspacePath: z.string().min(1) }).passthrough(),
    modelRef: ModelRefSchema,
    providerId: z.string().min(1),
    reason: z.enum(["model-request", "captcha-retry"]),
  })
  .strict();

export const SessionEventSchema = z
  .object({
    eventId: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().optional(),
    seq: z.number().int().nonnegative(),
    traceId: z.string().optional(),
    timestamp: z.number(),
    deliveryKind: z.string(),
    type: z.string().min(1),
    payload: RecordSchema,
  })
  .strict();

export const DynamicEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: SessionSnapshotSchema }).strict(),
  z.object({ type: z.literal("state.updated"), notification: z.unknown() }).strict(),
  z.object({ type: z.literal("permission.request"), request: PermissionRequestSchema }).strict(),
  z.object({ type: z.literal("userInput.request"), request: UserInputRequestSchema }).strict(),
  z
    .object({
      type: z.literal("userInput.response"),
      requestId: z.string(),
      response: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal("providerRuntimeHeaders.request"),
      request: ProviderRuntimeHeadersRequestSchema,
    })
    .strict(),
  z.object({ type: z.literal("session.event"), event: SessionEventSchema }).strict(),
]);

export type DynamicEvent = z.infer<typeof DynamicEventSchema>;
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;
export type PermissionResponse = z.infer<typeof PermissionResponseSchema>;
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;
export type SessionEvent = z.infer<typeof SessionEventSchema>;
