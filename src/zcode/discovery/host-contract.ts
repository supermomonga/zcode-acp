import { isAbsolute, join, relative } from "node:path";
import { AdapterError } from "../../domain/errors.ts";
import type { HostContractDescriptor } from "./types.ts";

export interface HostContractInspection {
  readonly hostIndexSha256: string;
  readonly hostRpcModuleSha256: string;
  readonly exports: readonly string[];
}

export function resolveHostContractPaths(
  installRoot: string,
  hostArchive: string,
  descriptor: HostContractDescriptor,
): { hostIndex: string; hostRpcModule: string } {
  const hostIndex = join(hostArchive, descriptor.hostIndexRelativePath);
  const hostRpcModule = join(hostArchive, descriptor.hostRpcModuleRelativePath);
  ensureInsideInstallRoot(installRoot, hostIndex);
  ensureInsideInstallRoot(installRoot, hostRpcModule);
  return { hostIndex, hostRpcModule };
}

export function hostContractMismatch(
  descriptor: HostContractDescriptor,
  inspection: HostContractInspection,
): string | undefined {
  for (const [operationName, operation] of Object.entries(descriptor.operations)) {
    if (descriptor.serviceChannels[operation.service] === undefined) {
      return `ZCode host contract operation ${operationName} references an unavailable service: ${operation.service}`;
    }
  }
  if (
    descriptor.hostIndexSha256 !== undefined &&
    descriptor.hostIndexSha256 !== inspection.hostIndexSha256
  ) {
    return "ZCode host index hash does not match the compatibility manifest";
  }
  if (
    descriptor.hostRpcModuleSha256 !== undefined &&
    descriptor.hostRpcModuleSha256 !== inspection.hostRpcModuleSha256
  ) {
    return "ZCode host RPC module hash does not match the compatibility manifest";
  }
  for (const exportName of Object.values(descriptor.rpcExports)) {
    if (!inspection.exports.includes(exportName)) {
      return `ZCode host RPC module is missing required export: ${exportName}`;
    }
  }
  return undefined;
}

function ensureInsideInstallRoot(root: string, path: string): void {
  const child = relative(root, path);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Resolved runtime path is outside the install root",
    );
  }
}
