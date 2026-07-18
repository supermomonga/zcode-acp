import { describe, expect, test } from "bun:test";
import {
  DynamicEventSchema,
  PermissionRequestSchema,
} from "../../src/zcode/protocol/v1/host-schemas.ts";

describe("ZCode host schemas", () => {
  test("accepts the observed permission shape without widening it", () => {
    const request = {
      requestId: "permission-1",
      sessionId: "session-1",
      toolCallId: "tool-1",
      toolName: "Write",
      reason: "Write a file",
      riskLevel: "medium" as const,
      input: { path: "/tmp/example" },
      options: [
        {
          optionId: "allow-once",
          kind: "allow_once",
          name: "Allow once",
          response: { decision: "allow" as const },
        },
        {
          optionId: "deny-once",
          kind: "deny_once",
          name: "Deny",
          response: { decision: "deny" as const, reason: "Denied" },
        },
      ],
    };
    expect(PermissionRequestSchema.parse(request)).toEqual(request);
    expect(() => PermissionRequestSchema.parse({ ...request, unexpected: true })).toThrow();
  });

  test("accepts observed model and tool events and rejects malformed sequence", () => {
    const base = {
      eventId: "event-1",
      sessionId: "session-1",
      turnId: "turn-1",
      seq: 1,
      timestamp: 1,
      deliveryKind: "desktop-continuous",
    };
    expect(DynamicEventSchema.parse({
      type: "session.event",
      event: { ...base, type: "model.streaming", payload: { kind: "text_delta", delta: "hi" } },
    })).toBeTruthy();
    expect(DynamicEventSchema.parse({
      type: "session.event",
      event: { ...base, eventId: "event-2", seq: 2, type: "tool.updated", payload: { kind: "result", toolCallId: "tool-1" } },
    })).toBeTruthy();
    expect(() => DynamicEventSchema.parse({
      type: "session.event",
      event: { ...base, seq: -1, type: "turn.completed", payload: { resultType: "success" } },
    })).toThrow();
  });
});
