import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StderrLogger } from "../../src/diagnostics/logger.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("diagnostic logger", () => {
  test("keeps stderr-only logging when no file is configured", () => {
    const directory = temporaryDirectory();
    const stderr = captureStderr();
    try {
      const logger = new StderrLogger("info");
      logger.log("info", "diagnostic.test", { sequence: 1 });
      logger.close();

      expect(stderr.lines).toHaveLength(1);
      expect(JSON.parse(stderr.lines[0]!)).toMatchObject({
        event: "diagnostic.test",
        sequence: 1,
        pid: process.pid,
      });
      expect(readFileNames(directory)).toEqual([]);
    } finally {
      stderr.restore();
    }
  });

  test("appends ordered redacted JSONL with mode 0600 and closes the file", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "diagnostics.jsonl");
    writeFileSync(path, '{"seed":true}\n', { mode: 0o644 });
    const stderr = captureStderr();
    try {
      const logger = new StderrLogger("debug", path);
      logger.log("info", "diagnostic.first", {
        sequence: 1,
        authorization: "Bearer secret-value",
      });
      logger.log("debug", "diagnostic.second", {
        sequence: 2,
        nested: { apiKey: "hidden" },
      });
      logger.close();

      expect(statSync(path).mode & 0o777).toBe(0o600);
      const lines = readFileSync(path, "utf8").trimEnd().split("\n");
      expect(JSON.parse(lines[0]!)).toEqual({ seed: true });
      expect(JSON.parse(lines[1]!)).toMatchObject({
        event: "diagnostic.first",
        sequence: 1,
        authorization: "[REDACTED]",
        pid: process.pid,
      });
      expect(JSON.parse(lines[2]!)).toMatchObject({
        event: "diagnostic.second",
        sequence: 2,
        nested: { apiKey: "[REDACTED]" },
        pid: process.pid,
      });
      expect(stderr.lines).toEqual(lines.slice(1).map((line) => `${line}\n`));

      const renamed = join(directory, "closed.jsonl");
      renameSync(path, renamed);
      const next = new StderrLogger("info", renamed);
      next.log("info", "diagnostic.third", { sequence: 3 });
      next.close();
      expect(readFileSync(renamed, "utf8")).toContain('"event":"diagnostic.third"');
    } finally {
      stderr.restore();
    }
  });

  test("rejects invalid or unwritable file targets explicitly", () => {
    expect(() => new StderrLogger("info", "relative.jsonl")).toThrow(
      "ZCODE_ACP_LOG_FILE must be an absolute path",
    );

    const directory = temporaryDirectory();
    expect(() => new StderrLogger("info", join(directory, "missing", "log.jsonl"))).toThrow(
      "ZCODE_ACP_LOG_FILE parent directory does not exist or is not a directory",
    );

    const locked = join(directory, "locked");
    mkdirSync(locked, { mode: 0o500 });
    try {
      expect(() => new StderrLogger("info", join(locked, "log.jsonl"))).toThrow(
        "ZCODE_ACP_LOG_FILE cannot be opened for writing",
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "zcode-acp-logger-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readFileNames(directory: string): string[] {
  return Array.from(new Bun.Glob("*").scanSync({ cwd: directory }));
}

function captureStderr(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines, restore: () => spy.mockRestore() };
}
