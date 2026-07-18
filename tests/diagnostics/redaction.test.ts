import { describe, expect, test } from "bun:test";
import { redactText, redactValue, safeError } from "../../src/diagnostics/redaction.ts";

describe("diagnostic redaction", () => {
  test("redacts secret keys recursively", () => {
    expect(
      redactValue({
        authorization: "Bearer secret-value",
        nested: { apiKey: "secret", visible: "ok" },
      }),
    ).toEqual({
      authorization: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", visible: "ok" },
    });
  });

  test("redacts bearer values in otherwise safe text", () => {
    expect(redactText("request failed: Bearer abc.def-123")).toBe(
      "request failed: [REDACTED]",
    );
  });

  test("does not include stacks in safe errors", () => {
    const error = new Error("failed with Bearer abc.def");
    expect(safeError(error)).toEqual({ name: "Error", message: "failed with [REDACTED]" });
  });
});

