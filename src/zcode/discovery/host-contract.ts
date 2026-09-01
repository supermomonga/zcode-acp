import { isAbsolute, join, relative } from "node:path";
import { AdapterError } from "../../domain/errors.ts";
import type { HostArtifactDescriptor, HostProtocolDescriptor } from "./types.ts";

export interface HostContractInspection {
  readonly hostIndexSha256: string;
  readonly hostRpcModuleSha256: string;
  readonly exports: readonly string[];
}

export function resolveHostContractPaths(
  installRoot: string,
  hostArchive: string,
  artifact: HostArtifactDescriptor,
): { hostIndex: string; hostRpcModule: string } {
  const hostIndex = join(hostArchive, artifact.hostIndexRelativePath);
  const hostRpcModule = join(hostArchive, artifact.hostRpcModuleRelativePath);
  ensureInsideInstallRoot(installRoot, hostIndex);
  ensureInsideInstallRoot(installRoot, hostRpcModule);
  return { hostIndex, hostRpcModule };
}

export function resolvedHostMismatch(
  artifact: HostArtifactDescriptor,
  protocol: HostProtocolDescriptor,
  inspection: HostContractInspection,
): string | undefined {
  if (artifact.protocolId !== protocol.id) {
    return "ZCode host artifact references an unavailable protocol";
  }
  for (const [operationName, operation] of Object.entries(protocol.operations)) {
    if (protocol.serviceChannels[operation.service] === undefined) {
      return `ZCode host protocol operation ${operationName} references an unavailable service: ${operation.service}`;
    }
  }
  if (artifact.hostIndexSha256 !== inspection.hostIndexSha256) {
    return "ZCode host index hash does not match the compatibility manifest";
  }
  if (artifact.hostRpcModuleSha256 !== inspection.hostRpcModuleSha256) {
    return "ZCode host RPC module hash does not match the compatibility manifest";
  }
  for (const exportName of Object.values(artifact.rpcExports)) {
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
