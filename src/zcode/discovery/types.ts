export interface BundleMetadata {
  readonly runtime: "electron-node";
  readonly entry: "zcode.cjs";
  readonly platform: string;
  readonly source: "apps/zcode-cli/packages/cli/dist/zcode.cjs";
}

export interface RuntimePaths {
  readonly installRoot: string;
  readonly executable: string;
  readonly cliEntry: string;
  readonly metadata: string;
  readonly appMetadata?: string;
  readonly appPackage: string;
  readonly hostArchive: string;
}

export type HostArtifactId = "zcode-host-3.11.2";

export type HostProtocolId = "zcode-task-v1";

export interface HostOperationDescriptor {
  readonly method: string;
  readonly service: "task";
  readonly sessionParameter: "taskId";
}

export interface HostArtifactDescriptor {
  readonly id: HostArtifactId;
  readonly appVersion: string;
  readonly cliVersion: string;
  readonly cliSha256: string;
  readonly protocolId: HostProtocolId;
  readonly hostIndexRelativePath: string;
  readonly hostRpcModuleRelativePath: string;
  readonly hostIndexSha256: string;
  readonly hostRpcModuleSha256: string;
  readonly rpcExports: {
    readonly protocol: string;
    readonly client: string;
    readonly service: string;
  };
}

export interface HostProtocolDescriptor {
  readonly id: HostProtocolId;
  readonly serviceChannels: {
    readonly agent: string;
    readonly task: string;
  };
  readonly operations: {
    readonly cancelGeneration: HostOperationDescriptor;
    readonly respondStructuredInput: HostOperationDescriptor;
    readonly respondPermission: HostOperationDescriptor;
  };
}

export interface ResolvedHost {
  readonly artifact: HostArtifactDescriptor;
  readonly protocol: HostProtocolDescriptor;
  readonly hostIndex: string;
  readonly hostRpcModule: string;
  readonly hostIndexSha256: string;
  readonly hostRpcModuleSha256: string;
  readonly rpcExports: readonly string[];
}

export type CompatibilityStatus =
  | "supported"
  | "unsupported";

export interface RuntimeIdentity {
  readonly platform: string;
  readonly appVersion?: string;
  readonly appBuild?: string;
  readonly cliVersion?: string;
  readonly cliSha256: string;
  readonly metadataSha256: string;
  readonly bundle: BundleMetadata;
}

export interface DiscoveredRuntime {
  readonly paths: RuntimePaths;
  readonly identity: RuntimeIdentity;
  readonly expectedCliSha256?: string;
  readonly cliIntegrity?: "verified" | "modified";
  readonly resolvedHost?: ResolvedHost;
  readonly compatibility: CompatibilityStatus;
  readonly compatibilityReason: string;
  readonly writableInstallRoot: boolean;
}

export interface RuntimeSmokeResult {
  readonly passed: boolean;
  readonly cliVersion?: string;
  readonly doctorPassed: boolean;
  readonly authentication: "present" | "missing" | "unknown";
  readonly error?: string;
}
