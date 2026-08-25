export interface BundleMetadata {
  readonly runtime: "electron-node";
  readonly entry: string;
  readonly platform: string;
  readonly source: string;
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

export type HostContractId =
  | "zcode-host-3.3.6"
  | "zcode-host-3.8.1"
  | "zcode-host-3.9.1";

export interface HostOperationDescriptor {
  readonly method: string;
  readonly service: "agent" | "task";
  readonly sessionParameter: "sessionId" | "taskId";
}

export interface HostContractDescriptor {
  readonly id: HostContractId;
  readonly hostIndexRelativePath: string;
  readonly hostRpcModuleRelativePath: string;
  readonly hostIndexSha256?: string;
  readonly hostRpcModuleSha256?: string;
  readonly rpcExports: {
    readonly protocol: string;
    readonly client: string;
    readonly service: string;
  };
  readonly serviceChannels: {
    readonly agent: string;
    readonly task?: string;
  };
  readonly operations: {
    readonly cancelGeneration: HostOperationDescriptor;
    readonly respondStructuredInput: HostOperationDescriptor & {
      readonly responseShape: "nested" | "flattened";
    };
    readonly respondPermission: HostOperationDescriptor & {
      readonly answerShape: "response" | "optionId";
    };
  };
}

export interface ResolvedHostContract {
  readonly descriptor: HostContractDescriptor;
  readonly hostIndex: string;
  readonly hostRpcModule: string;
  readonly hostIndexSha256: string;
  readonly hostRpcModuleSha256: string;
  readonly rpcExports: readonly string[];
}

export type CompatibilityStatus =
  | "supported"
  | "development-candidate"
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
  readonly hostContract?: ResolvedHostContract;
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
