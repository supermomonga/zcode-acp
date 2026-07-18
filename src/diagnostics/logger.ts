import { redactValue, safeError } from "./redaction.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  error(event: string, error: unknown, data?: Record<string, unknown>): void;
}

export class StderrLogger implements Logger {
  constructor(private readonly minimumLevel: LogLevel = "info") {}

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[this.minimumLevel]) {
      return;
    }

    const record = redactValue({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
    });
    process.stderr.write(`${JSON.stringify(record)}\n`);
  }

  error(event: string, error: unknown, data: Record<string, unknown> = {}): void {
    this.log("error", event, { ...data, error: safeError(error) });
  }
}

export class NullLogger implements Logger {
  log(_level: LogLevel, _event: string, _data?: Record<string, unknown>): void {}
  error(_event: string, _error: unknown, _data?: Record<string, unknown>): void {}
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

