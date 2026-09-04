import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { NullLogger } from "../../src/diagnostics/logger.ts";
import { AdapterError } from "../../src/domain/errors.ts";
import type {
  PlanApprovalRequest,
  PlanApprovalResult,
  SessionInteraction,
  SessionUpdate,
} from "../../src/domain/session-contract.ts";
import { HeadlessZCodeSessionEngine } from "../../src/domain/session-service.ts";
import type {
  DynamicEvent,
  PermissionRequest,
  SessionSnapshot,
  UserInputRequest,
} from "../../src/zcode/protocol/v1/host-schemas.ts";

describe("ZCode plan approval conversion", () => {
  test("publishes a markdown plan before form elicitation and returns the selected permission option", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());

      expect(harness.timeline.slice(-2)).toEqual([
        "notify:plan_update",
        "plan-approval",
      ]);
      expect(harness.updates.at(-1)).toEqual({
        sessionUpdate: "plan_update",
        plan: {
          type: "markdown",
          planId: "zcode-plan-proposal:permission-plan",
          content: "# Proposed plan\n\n1. Change it",
        },
      });
      expect(harness.permissionRequests).toHaveLength(0);
      expect(harness.planApprovalRequests).toEqual([{
        sessionId: "session-1",
        toolCallId: "exit-plan-tool",
        message: "Approve the plan",
        options: [
          { optionId: "allow-plan", name: "Approve" },
          { optionId: "deny-plan", name: "Reject" },
        ],
      }]);
      expect(harness.hostRequests.at(-1)).toMatchObject({
        method: "respondPermission",
        params: {
          requestId: "permission-plan",
          optionId: "allow-plan",
          response: { decision: "allow" },
        },
      });

      await harness.completeTurn();
      await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(harness.updates.at(-1)).toEqual({
        sessionUpdate: "plan_removed",
        planId: "zcode-plan-proposal:permission-plan",
      });
    } finally {
      await harness.service.close();
    }
  });

  test("uses legacy plan entries when plan operations are not advertised", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: false });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());

      expect(planUpdates(harness.updates)).toEqual([
        {
          sessionUpdate: "plan",
          entries: [{
            content: "# Proposed plan\n\n1. Change it",
            priority: "high",
            status: "pending",
          }],
        },
        {
          sessionUpdate: "plan",
          entries: [{
            content: "# Proposed plan\n\n1. Change it",
            priority: "high",
            status: "in_progress",
          }],
        },
      ]);

      await harness.completeTurn();
      await expect(prompt).resolves.toBeDefined();
      expect(planUpdates(harness.updates).at(-1)).toEqual({
        sessionUpdate: "plan",
        entries: [],
      });
    } finally {
      await harness.service.close();
    }
  });

  test("converts userInput plan approval and preserves its option ID", async () => {
    const harness = await createPlanHarness({
      planOperationsSupported: true,
      planApprovalResult: { action: "accept", optionId: "approve" },
    });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitUserInput(planUserInputRequest());

      expect(harness.timeline.slice(-2)).toEqual(["notify:plan_update", "plan-approval"]);
      expect(harness.hostRequests.at(-1)).toMatchObject({
        method: "respondStructuredInput",
        params: {
          requestId: "user-input-plan",
          response: {
            action: "accept",
            content: {
              answer_0: "approve",
              answer: "approve",
              answers: { "Review this implementation plan.": ["approve"] },
            },
          },
        },
      });

      await harness.completeTurn();
      await expect(prompt).resolves.toBeDefined();
    } finally {
      await harness.service.close();
    }
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`removes the proposal immediately when elicitation returns ${action}`, async () => {
      const harness = await createPlanHarness({
        planOperationsSupported: true,
        planApprovalResult: { action },
      });
      try {
        const prompt = harness.startPrompt();
        await harness.promptAccepted;
        await harness.emitPermission(planPermissionRequest());

        expect(harness.updates.slice(-2)).toEqual([
          expect.objectContaining({ sessionUpdate: "plan_update" }),
          {
            sessionUpdate: "plan_removed",
            planId: "zcode-plan-proposal:permission-plan",
          },
        ]);
        expect(harness.hostRequests.at(-1)).toMatchObject({
          method: "respondPermission",
          params: { optionId: "deny-plan", response: { decision: "deny" } },
        });

        await harness.completeTurn();
        await expect(prompt).resolves.toBeDefined();
      } finally {
        await harness.service.close();
      }
    });
  }

  test("fails closed when form elicitation is unavailable", async () => {
    const harness = await createPlanHarness({
      planOperationsSupported: true,
      planApprovalError: new AdapterError(
        "INTERACTION_UNSUPPORTED",
        "The client does not support form elicitation",
      ),
    });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());

      await expect(prompt).rejects.toMatchObject({ code: "INTERACTION_UNSUPPORTED" });
      expect(harness.hostRequests).toContainEqual(expect.objectContaining({
        method: "respondPermission",
        params: expect.objectContaining({ optionId: "deny-plan" }),
      }));
      expect(harness.updates.at(-1)).toEqual({
        sessionUpdate: "plan_removed",
        planId: "zcode-plan-proposal:permission-plan",
      });
    } finally {
      await harness.service.close();
    }
  });

  test("fails closed on missing plan content and an unknown selected option", async () => {
    for (const scenario of ["missing-plan", "unknown-option"] as const) {
      const harness = await createPlanHarness({
        planOperationsSupported: true,
        ...(scenario === "unknown-option"
          ? { planApprovalResult: { action: "accept" as const, optionId: "not-native" } }
          : {}),
      });
      try {
        const prompt = harness.startPrompt();
        await harness.promptAccepted;
        const request = planPermissionRequest();
        if (scenario === "missing-plan") request.input = {};
        await harness.emitPermission(request);

        await expect(prompt).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
        expect(harness.hostRequests).toContainEqual(expect.objectContaining({
          method: "respondPermission",
          params: expect.objectContaining({ optionId: "deny-plan" }),
        }));
        if (scenario === "unknown-option") {
          expect(harness.updates.at(-1)).toEqual({
            sessionUpdate: "plan_removed",
            planId: "zcode-plan-proposal:permission-plan",
          });
        }
      } finally {
        await harness.service.close();
      }
    }
  });

  test("removes an accepted proposal on cancellation", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());
      await harness.service.cancel({ sessionId: "session-1" });

      expect(harness.updates.at(-1)).toEqual({
        sessionUpdate: "plan_removed",
        planId: "zcode-plan-proposal:permission-plan",
      });
      await harness.failTurn();
      await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    } finally {
      await harness.service.close();
    }
  });

  test("removes the previous proposal before publishing a replacement", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());
      const replacement = planPermissionRequest();
      replacement.requestId = "permission-plan-2";
      replacement.input = { plan: "# Replacement" };
      await harness.emitPermission(replacement);

      expect(planUpdates(harness.updates).slice(-3)).toEqual([
        expect.objectContaining({
          sessionUpdate: "plan_update",
          plan: expect.objectContaining({ planId: "zcode-plan-proposal:permission-plan" }),
        }),
        {
          sessionUpdate: "plan_removed",
          planId: "zcode-plan-proposal:permission-plan",
        },
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "markdown",
            planId: "zcode-plan-proposal:permission-plan-2",
            content: "# Replacement",
          },
        },
      ]);
      await harness.completeTurn();
      await expect(prompt).resolves.toBeDefined();
    } finally {
      await harness.service.close();
    }
  });

  test("removes an accepted proposal when the native turn fails", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitPermission(planPermissionRequest());
      await harness.failTurn();

      await expect(prompt).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      expect(harness.updates.at(-1)).toEqual({
        sessionUpdate: "plan_removed",
        planId: "zcode-plan-proposal:permission-plan",
      });
    } finally {
      await harness.service.close();
    }
  });

  test("replaces todos completely and removes the items plan when they become empty", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      await harness.emitSnapshot([{ content: "First", status: "pending", priority: "high" }]);
      await harness.emitSnapshot([{ content: "First", status: "completed", priority: "high" }]);
      await harness.emitSnapshot([]);

      expect(planUpdates(harness.updates)).toEqual([
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "zcode-todos",
            entries: [{ content: "First", status: "pending", priority: "high" }],
          },
        },
        {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "zcode-todos",
            entries: [{ content: "First", status: "completed", priority: "high" }],
          },
        },
        { sessionUpdate: "plan_removed", planId: "zcode-todos" },
      ]);
      await harness.completeTurn();
      await expect(prompt).resolves.toBeDefined();
    } finally {
      await harness.service.close();
    }
  });

  test("keeps ordinary permission requests on the permission interaction", async () => {
    const harness = await createPlanHarness({ planOperationsSupported: true });
    try {
      const prompt = harness.startPrompt();
      await harness.promptAccepted;
      const request = planPermissionRequest();
      request.toolName = "Bash";
      await harness.emitPermission(request);

      expect(harness.permissionRequests).toHaveLength(1);
      expect(harness.planApprovalRequests).toHaveLength(0);
      expect(planUpdates(harness.updates)).toHaveLength(0);
      await harness.completeTurn();
      await expect(prompt).resolves.toBeDefined();
    } finally {
      await harness.service.close();
    }
  });
});

interface PlanHarness {
  readonly service: HeadlessZCodeSessionEngine;
  readonly updates: SessionUpdate[];
  readonly timeline: string[];
  readonly hostRequests: Array<{ method: string; params: Record<string, unknown> }>;
  readonly permissionRequests: PermissionRequest[];
  readonly planApprovalRequests: PlanApprovalRequest[];
  readonly promptAccepted: Promise<void>;
  startPrompt(): Promise<unknown>;
  emitPermission(request: PermissionRequest): Promise<void>;
  emitUserInput(request: UserInputRequest): Promise<void>;
  emitSnapshot(todos: NonNullable<SessionSnapshot["todos"]>): Promise<void>;
  completeTurn(): Promise<void>;
  failTurn(): Promise<void>;
}

async function createPlanHarness(options: {
  readonly planOperationsSupported: boolean;
  readonly planApprovalResult?: PlanApprovalResult;
  readonly planApprovalError?: Error;
}): Promise<PlanHarness> {
  const workspacePath = await realpath(process.cwd());
  let todos: NonNullable<SessionSnapshot["todos"]> = [];
  const snapshot = (): SessionSnapshot => ({
    session: {
      sessionId: "session-1",
      status: "idle",
      workspace: { workspacePath },
    },
    settings: {
      model: {
        current: { providerId: "builtin:zai-coding-plan", modelId: "GLM-5.2" },
        available: [],
      },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "plan" },
    },
    messages: [],
    runtime: {},
    todos,
    slashCommands: [],
  });
  const updates: SessionUpdate[] = [];
  const timeline: string[] = [];
  const hostRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const permissionRequests: PermissionRequest[] = [];
  const planApprovalRequests: PlanApprovalRequest[] = [];
  const promptAccepted = Promise.withResolvers<void>();
  let subscription: ((event: DynamicEvent) => Promise<void> | void) | undefined;
  let sequence = 0;
  const bridge = {
    async request(method: string, params: Record<string, unknown>) {
      hostRequests.push({ method, params });
      if (method === "initialize") return { available: true };
      if (method === "readWorkspaceState") {
        return {
          workspace: { workspacePath },
          settings: snapshot().settings,
          modelCatalog: { providers: [{}], available: [] },
        };
      }
      if (method === "createSession" || method === "readSession") return snapshot();
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
      if (
        method === "respondPermission" ||
        method === "respondStructuredInput" ||
        method === "cancelGeneration"
      ) return null;
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
  await service.newSession({ cwd: workspacePath, mcpServers: [] });
  const interaction: SessionInteraction = {
    planOperationsSupported: options.planOperationsSupported,
    async notify(_sessionId, update) {
      updates.push(update);
      timeline.push(`notify:${update.sessionUpdate}`);
    },
    async requestPermission(request) {
      permissionRequests.push(request);
      timeline.push("permission");
      return { optionId: "deny-plan" };
    },
    async requestPlanApproval(request) {
      planApprovalRequests.push(request);
      timeline.push("plan-approval");
      if (options.planApprovalError !== undefined) throw options.planApprovalError;
      return options.planApprovalResult ?? { action: "accept", optionId: "allow-plan" };
    },
    async requestUserInput() {
      return { action: "decline" };
    },
  };

  const emit = async (event: DynamicEvent) => {
    if (subscription === undefined) throw new Error("Subscription was not established");
    await subscription(event);
  };
  const terminal = async (type: "turn.completed" | "turn.failed", payload: Record<string, unknown>) => {
    sequence += 1;
    await emit({
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
    timeline,
    hostRequests,
    permissionRequests,
    planApprovalRequests,
    promptAccepted: promptAccepted.promise,
    startPrompt: () => service.prompt(
      { sessionId: "session-1", prompt: [{ type: "text", text: "Make a plan" }] },
      interaction,
      new AbortController().signal,
    ),
    emitPermission: (request) => emit({ type: "permission.request", request }),
    emitUserInput: (request) => emit({ type: "userInput.request", request }),
    emitSnapshot: async (nextTodos) => {
      todos = nextTodos;
      await emit({ type: "snapshot", snapshot: snapshot() });
    },
    completeTurn: () => terminal("turn.completed", { resultType: "success" }),
    failTurn: () => terminal("turn.failed", { error: { message: "cancelled" } }),
  };
}

function planPermissionRequest(): PermissionRequest {
  return {
    requestId: "permission-plan",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "exit-plan-tool",
    toolName: "ExitPlanMode",
    reason: "Approve the plan",
    riskLevel: "medium",
    input: { plan: "# Proposed plan\n\n1. Change it" },
    options: [
      {
        optionId: "allow-plan",
        kind: "allow_once",
        name: "Approve",
        response: { decision: "allow" },
      },
      {
        optionId: "deny-plan",
        kind: "reject_once",
        name: "Reject",
        response: { decision: "deny" },
      },
    ],
  };
}

function planUserInputRequest(): UserInputRequest {
  return {
    requestId: "user-input-plan",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "exit-plan-tool",
    toolName: "ExitPlanMode",
    prompt: "Review this implementation plan.",
    questions: [{
      question: "Review this implementation plan.",
      header: "Plan",
      options: [{
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      }],
    }],
    input: { plan: "# Proposed plan\n\n1. Change it" },
    schema: { interaction: "plan_approval" },
  };
}

function planUpdates(updates: SessionUpdate[]): SessionUpdate[] {
  return updates.filter((update) =>
    update.sessionUpdate === "plan" ||
    update.sessionUpdate === "plan_update" ||
    update.sessionUpdate === "plan_removed"
  );
}
