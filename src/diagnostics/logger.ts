import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { redactValue, safeError } from "./redaction.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  error(event: string, error: unknown, data?: Record<string, unknown>): void;
}

export class StderrLogger implements Logger {
  private fileDescriptor: number | undefined;

  constructor(
    private readonly minimumLevel: LogLevel = "info",
    filePath?: string,
  ) {
    if (filePath !== undefined) {
      this.fileDescriptor = openLogFile(filePath);
    }
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    if (LEVELS[level] < LEVELS[this.minimumLevel]) {
      return;
    }

    const record = redactValue({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data,
      pid: process.pid,
    });
    const line = `${JSON.stringify(record)}\n`;
    process.stderr.write(line);
    if (this.fileDescriptor !== undefined) {
      try {
        const written = writeSync(this.fileDescriptor, line);
        if (written !== Buffer.byteLength(line)) {
          throw new Error("partial write");
        }
      } catch {
        throw new Error("Failed to write ZCODE_ACP_LOG_FILE");
      }
    }
  }

  error(event: string, error: unknown, data: Record<string, unknown> = {}): void {
    this.log("error", event, { ...data, error: safeError(error) });
  }

  close(): void {
    if (this.fileDescriptor === undefined) {
      return;
    }
    const fileDescriptor = this.fileDescriptor;
    this.fileDescriptor = undefined;
    try {
      closeSync(fileDescriptor);
    } catch {
      throw new Error("Failed to close ZCODE_ACP_LOG_FILE");
    }
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

function openLogFile(filePath: string): number {
  if (!isAbsolute(filePath)) {
    throw new Error("ZCODE_ACP_LOG_FILE must be an absolute path");
  }

  try {
    if (!statSync(dirname(filePath)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error("ZCODE_ACP_LOG_FILE parent directory does not exist or is not a directory");
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(
      filePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
      0o600,
    );
  } catch {
    throw new Error("ZCODE_ACP_LOG_FILE cannot be opened for writing");
  }

  try {
    if (!fstatSync(fileDescriptor).isFile()) {
      throw new Error("not a regular file");
    }
    fchmodSync(fileDescriptor, 0o600);
    return fileDescriptor;
  } catch {
    closeSync(fileDescriptor);
    throw new Error("ZCODE_ACP_LOG_FILE must be a writable regular file");
  }
}
