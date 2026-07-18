import type { RuntimeIdentity } from "./types.ts";

interface CompatibilityEntry {
  readonly platform: string;
  readonly appVersion: string;
  readonly appBuild?: string;
  readonly cliVersion: string;
  readonly cliSha256: string;
  readonly metadataSha256: string;
  readonly releaseGatesPassed: boolean;
}

const COMPATIBILITY_ENTRIES: readonly CompatibilityEntry[] = [
  {
    platform: "darwin-arm64",
    appVersion: "3.3.6",
    appBuild: "3.3.6.3198",
    cliVersion: "0.15.2",
    cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
    metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
    releaseGatesPassed: true,
  },
  {
    platform: "linux-x64",
    appVersion: "3.3.6",
    cliVersion: "0.15.2",
    cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
    metadataSha256: "3d0fccf8be60268be3749913f683a5e7e0f8c6e0719d32cc41e3d272b8436f51",
    releaseGatesPassed: true,
  },
];

export function assessCompatibility(identity: RuntimeIdentity): {
  status: "supported" | "development-candidate" | "unsupported";
  reason: string;
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
    };
  }

  return { status: "supported", reason: "All compatibility release gates passed" };
}
