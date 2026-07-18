import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspace } from "../../src/domain/workspace.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("workspace identity", () => {
  test("canonicalizes an existing absolute directory", async () => {
    const path = await mkdtemp(join(tmpdir(), "zcode-acp-workspace-"));
    temporaryPaths.push(path);

    const workspace = await resolveWorkspace(path);

    const canonical = await realpath(path);
    expect(workspace.cwd).toBe(canonical);
    expect(workspace.native).toEqual({ workspacePath: canonical, workspaceKey: canonical });
  });

  test("rejects relative paths", async () => {
    await expect(resolveWorkspace("relative/path")).rejects.toMatchObject({
      code: "INVALID_WORKSPACE",
    });
  });

  test("rejects missing paths", async () => {
    await expect(resolveWorkspace(join(tmpdir(), crypto.randomUUID()))).rejects.toMatchObject({
      code: "INVALID_WORKSPACE",
    });
  });
});
