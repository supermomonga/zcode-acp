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
  readonly hostIndex: string;
  readonly hostRpcModule: string;
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
