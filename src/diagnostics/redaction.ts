const SECRET_KEY =
  /(?:authorization|cookie|credential|password|secret|token|api[-_]?key|headers?)/i;

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|api)[-_][A-Za-z0-9_-]{16,}\b/gi,
];

export function redactText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen);
  }
  return result;
}

export function safeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
} {
  if (!(error instanceof Error)) {
    return { name: "Error", message: redactText(String(error)) };
  }

  const result: { name: string; message: string; code?: string } = {
    name: error.name,
    message: redactText(error.message),
  };
  if ("code" in error && typeof error.code === "string") {
    result.code = error.code;
  }
  return result;
}

