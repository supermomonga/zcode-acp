import type {
  PermissionRequest,
  PermissionResponse,
  UserInputRequest,
} from "../zcode/protocol/v1/host-schemas.ts";

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ResourceLinkContentBlock {
  type: "resource_link";
  name: string;
  uri: string;
  mimeType?: string | null;
  size?: number | null;
}

export interface BinaryContentBlock {
  type: "image" | "audio";
  data: string;
  mimeType: string;
  uri?: string | null;
}

export interface EmbeddedResourceContentBlock {
  type: "resource";
  resource:
    | { uri: string; mimeType?: string | null; text: string }
    | { uri: string; mimeType?: string | null; blob: string };
}

export type PromptContentBlock =
  | TextContentBlock
  | ResourceLinkContentBlock
  | BinaryContentBlock
  | EmbeddedResourceContentBlock;

export type McpServer = Record<string, unknown>;

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
}

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string };
}

export interface SessionState {
  modes?: {
    currentModeId: string;
    availableModes: SessionMode[];
  };
  configOptions?: SessionConfigOption[];
}

export interface SessionSetup extends SessionState {
  sessionId: string;
}

export interface SessionListEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface PermissionSelection {
  optionId: string;
}

export type UserInputResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

export interface PlanApprovalRequest {
  sessionId: string;
  toolCallId?: string;
  message: string;
  options: Array<{
    optionId: string;
    name: string;
    description?: string;
  }>;
}

export type PlanApprovalResult =
  | { action: "accept"; optionId: string }
  | { action: "decline" | "cancel" };

export interface SessionInteraction {
  readonly planOperationsSupported: boolean;
  notify(sessionId: string, update: SessionUpdate): Promise<void>;
  requestPermission(request: PermissionRequest): Promise<PermissionSelection | null>;
  requestPlanApproval(request: PlanApprovalRequest): Promise<PlanApprovalResult>;
  requestUserInput(request: UserInputRequest): Promise<UserInputResult>;
}

export interface PromptResult {
  stopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled";
  usage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
  };
}

export interface SessionEngine {
  newSession(params: {
    cwd: string;
    mcpServers: McpServer[];
    additionalDirectories?: string[];
  }): Promise<SessionSetup>;
  loadSession(
    params: {
      cwd: string;
      sessionId: string;
      mcpServers: McpServer[];
      additionalDirectories?: string[];
    },
    interaction: SessionInteraction,
  ): Promise<SessionState>;
  resumeSession(params: {
    cwd: string;
    sessionId: string;
    mcpServers?: McpServer[];
    additionalDirectories?: string[];
  }): Promise<SessionState>;
  listSessions(params: { cwd?: string | null; cursor?: string | null }): Promise<{
    sessions: SessionListEntry[];
  }>;
  closeSession(params: { sessionId: string }): Promise<void>;
  setSessionMode(
    params: { sessionId: string; modeId: string },
    interaction?: SessionInteraction,
  ): Promise<void>;
  setSessionConfigOption(
    params: { sessionId: string; configId: string; value: unknown; type?: string },
    interaction?: SessionInteraction,
  ): Promise<{ configOptions: SessionConfigOption[] }>;
  authenticate(): Promise<void>;
  logout(): Promise<void>;
  prompt(
    params: { sessionId: string; prompt: PromptContentBlock[] },
    interaction: SessionInteraction,
    signal: AbortSignal,
  ): Promise<PromptResult>;
  cancel(params: { sessionId: string }): Promise<void>;
  close(): Promise<void>;
}

export type { PermissionRequest, PermissionResponse, UserInputRequest };
