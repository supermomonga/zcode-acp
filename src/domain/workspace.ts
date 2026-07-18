import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AdapterError } from "./errors.ts";

export interface WorkspaceIdentity {
  readonly cwd: string;
  readonly key: string;
  readonly native: {
    readonly workspacePath: string;
    readonly workspaceKey: string;
  };
}

export async function resolveWorkspace(cwd: string): Promise<WorkspaceIdentity> {
  if (!isAbsolute(cwd)) {
    throw new AdapterError("INVALID_WORKSPACE", "Workspace path must be absolute");
  }

  let canonical: string;
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      throw new AdapterError("INVALID_WORKSPACE", "Workspace path is not a directory");
    }
    canonical = await realpath(cwd);
  } catch (error) {
    if (error instanceof AdapterError) {
      throw error;
    }
    throw new AdapterError("INVALID_WORKSPACE", "Workspace path does not exist", {}, { cause: error });
  }

  return {
    cwd: canonical,
    key: canonical,
    native: {
      workspacePath: canonical,
      workspaceKey: canonical,
    },
  };
}
