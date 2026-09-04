import type {
  HostArtifactDescriptor,
  HostProtocolDescriptor,
  RuntimeIdentity,
} from "./types.ts";

export const CURRENT_HOST_PROTOCOL: HostProtocolDescriptor = {
  id: "zcode-task-v1",
  serviceChannels: { agent: "zcode-agent", task: "zcode-task" },
  operations: {
    cancelGeneration: { method: "stopGeneration", service: "task", sessionParameter: "taskId" },
    respondStructuredInput: {
      method: "respondElicitation",
      service: "task",
      sessionParameter: "taskId",
    },
    respondPermission: {
      method: "respondPermission",
      service: "task",
      sessionParameter: "taskId",
    },
  },
};

export const CURRENT_ZCODE_ARTIFACT: HostArtifactDescriptor = {
  id: "zcode-host-3.11.2",
  appVersion: "3.11.2",
  cliVersion: "0.16.5",
  cliSha256: "e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8",
  protocolId: "zcode-task-v1",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-KGXW6KHC.js",
  hostIndexSha256: "30911a90dadc5c384959d00d95ccc70c8cf38c74a9cb99c3168b0897d046d215",
  hostRpcModuleSha256: "e66203598b60d8728260ad7631f295f9d6deb8276b06e8f0cab8776773c75b31",
  rpcExports: { protocol: "g", client: "i", service: "j" },
};

export function assessCompatibility(identity: RuntimeIdentity): {
  status: "supported" | "unsupported";
  reason: string;
  expectedCliSha256?: string;
  cliIntegrity?: "verified" | "modified";
  hostArtifact?: HostArtifactDescriptor;
  hostProtocol?: HostProtocolDescriptor;
} {
  if (
    identity.appVersion !== CURRENT_ZCODE_ARTIFACT.appVersion ||
    identity.cliVersion !== CURRENT_ZCODE_ARTIFACT.cliVersion
  ) {
    return {
      status: "unsupported",
      reason: "ZCode app or CLI version does not match the current compatibility manifest",
    };
  }

  const cliIntegrity = CURRENT_ZCODE_ARTIFACT.cliSha256 === identity.cliSha256
    ? "verified"
    : "modified";

  return {
    status: "supported",
    reason: cliIntegrity === "verified"
      ? "ZCode app and CLI versions match the current compatibility manifest; the CLI artifact is verified"
      : "ZCode app and CLI versions match; the CLI content differs from the verified artifact",
    expectedCliSha256: CURRENT_ZCODE_ARTIFACT.cliSha256,
    cliIntegrity,
    hostArtifact: CURRENT_ZCODE_ARTIFACT,
    hostProtocol: CURRENT_HOST_PROTOCOL,
  };
}
