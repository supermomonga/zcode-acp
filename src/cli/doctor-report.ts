import type {
  DiscoveredRuntime,
  RuntimeSmokeResult,
} from "../zcode/discovery/types.ts";

export function createDoctorReport(
  runtime: DiscoveredRuntime,
  smoke: RuntimeSmokeResult,
): Record<string, unknown> {
  return {
    platform: runtime.identity.platform,
    zcodeInstall: runtime.paths.installRoot,
    zcodeAppVersion: runtime.identity.appVersion ?? null,
    zcodeBuild: runtime.identity.appBuild ?? null,
    zcodeCliVersion: runtime.identity.cliVersion ?? smoke.cliVersion ?? null,
    runtime: runtime.identity.bundle.runtime,
    cliSha256: runtime.identity.cliSha256,
    expectedCliSha256: runtime.expectedCliSha256 ?? null,
    cliIntegrity: runtime.cliIntegrity ?? null,
    metadataSha256: runtime.identity.metadataSha256,
    hostArtifact: runtime.resolvedHost?.artifact.id ?? null,
    hostProtocol: runtime.resolvedHost?.protocol.id ?? null,
    hostIndexSha256: runtime.resolvedHost?.hostIndexSha256 ?? null,
    hostRpcModuleSha256: runtime.resolvedHost?.hostRpcModuleSha256 ?? null,
    compatibility: runtime.compatibility,
    compatibilityReason: runtime.compatibilityReason,
    runtimeSmoke: smoke.passed ? "passed" : "failed",
    authentication: smoke.authentication,
    providerHeadersBridge: "installed-host",
    installRootWritableByGroupOrOthers: runtime.writableInstallRoot,
  };
}
