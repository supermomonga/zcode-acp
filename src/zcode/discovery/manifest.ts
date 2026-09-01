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
  id: "zcode-host-3.10.2",
  appVersion: "3.10.2",
  cliVersion: "0.16.5",
  cliSha256: "3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc",
  protocolId: "zcode-task-v1",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-KGXW6KHC.js",
  hostIndexSha256: "72e57751ed5563338335a52cd688c7fba0707ef72d8ce782356b1f0b39c77462",
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
