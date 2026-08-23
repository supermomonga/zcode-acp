import type { HostContractDescriptor, RuntimeIdentity } from "./types.ts";

interface CompatibilityEntry {
  readonly platform: string;
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly cliVersion: string;
  readonly cliSha256: string;
  readonly metadataSha256: string;
  readonly hostContract: HostContractDescriptor;
  readonly releaseGatesPassed: boolean;
}

const LEGACY_HOST_CONTRACT: HostContractDescriptor = {
  id: "zcode-host-3.3.6",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-HAEWO5CB.js",
  rpcExports: { protocol: "g", client: "i", service: "j" },
  serviceChannels: { agent: "zcode-agent" },
  operations: {
    cancelGeneration: { method: "stopSession", service: "agent", sessionParameter: "sessionId" },
    respondStructuredInput: {
      method: "respondUserInput",
      service: "agent",
      sessionParameter: "sessionId",
      responseShape: "nested",
    },
    respondPermission: {
      method: "respondPermission",
      service: "agent",
      sessionParameter: "sessionId",
      answerShape: "response",
    },
  },
};

const ZCODE_3_8_1_HOST_CONTRACT: HostContractDescriptor = {
  id: "zcode-host-3.8.1",
  hostIndexRelativePath: "out/host/index.js",
  hostRpcModuleRelativePath: "out/host/chunk-LVLFJXEE.js",
  hostIndexSha256: "d0f825035b4d0dd88215ec2f4c165be8ea3c255178b06f2b614e88cc84159c3f",
  hostRpcModuleSha256: "46959e5a9b0564b74b1d4c7fa56ff3d64485398141a9ebb97dda39657eee9fc3",
  rpcExports: { protocol: "g", client: "i", service: "j" },
  serviceChannels: { agent: "zcode-agent", task: "zcode-task" },
  operations: {
    cancelGeneration: { method: "stopGeneration", service: "task", sessionParameter: "taskId" },
    respondStructuredInput: {
      method: "respondElicitation",
      service: "task",
      sessionParameter: "taskId",
      responseShape: "flattened",
    },
    respondPermission: {
      method: "respondPermission",
      service: "task",
      sessionParameter: "taskId",
      answerShape: "optionId",
    },
  },
};

const COMPATIBILITY_ENTRIES: readonly CompatibilityEntry[] = [
  {
    platform: "darwin-arm64",
    appVersion: "3.3.6",
    appBuild: "3.3.6.3198",
    cliVersion: "0.15.2",
    cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
    metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
    hostContract: LEGACY_HOST_CONTRACT,
    releaseGatesPassed: true,
  },
  {
    platform: "darwin-arm64",
    appVersion: "3.8.1",
    appBuild: "3.8.1.5310",
    cliVersion: "0.16.3",
    cliSha256: "9318f60fb8c2c3bc83ce62da10220ebcdc9a99786df0a9abb1a4435ba66e4274",
    metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
    hostContract: ZCODE_3_8_1_HOST_CONTRACT,
    releaseGatesPassed: true,
  },
  {
    platform: "linux-x64",
    appVersion: "3.3.6",
    cliVersion: "0.15.2",
    cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
    metadataSha256: "3d0fccf8be60268be3749913f683a5e7e0f8c6e0719d32cc41e3d272b8436f51",
    hostContract: LEGACY_HOST_CONTRACT,
    releaseGatesPassed: true,
  },
];

export function assessCompatibility(identity: RuntimeIdentity): {
  status: "supported" | "development-candidate" | "unsupported";
  reason: string;
  hostContract?: HostContractDescriptor;
} {
  const match = COMPATIBILITY_ENTRIES.find(
    (entry) =>
      entry.platform === identity.platform &&
      entry.appVersion === identity.appVersion &&
      entry.appBuild === identity.appBuild &&
      entry.cliVersion === identity.cliVersion &&
      entry.cliSha256 === identity.cliSha256 &&
      entry.metadataSha256 === identity.metadataSha256,
  );

  if (!match) {
    return {
      status: "unsupported",
      reason: "Artifact identity is not present in the compatibility manifest",
    };
  }

  if (!match.releaseGatesPassed) {
    return {
      status: "development-candidate",
      reason: "Artifact matches the investigated snapshot, but Phase 0 and release gates are incomplete",
      hostContract: match.hostContract,
    };
  }

  return {
    status: "supported",
    reason: "All compatibility release gates passed",
    hostContract: match.hostContract,
  };
}
