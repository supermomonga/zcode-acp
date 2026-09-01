import { describe, expect, test } from "bun:test";
import {
  assessCompatibility,
  CURRENT_HOST_PROTOCOL,
  CURRENT_ZCODE_ARTIFACT,
} from "../../src/zcode/discovery/manifest.ts";
import type { RuntimeIdentity } from "../../src/zcode/discovery/types.ts";

const OFFICIAL_CLI_SHA256 =
  "3597160465b67da248fa3fb919920ca30d4e093003a4d70cde2a2e33903cbabc";

function identity(
  platform: string,
  overrides: Partial<RuntimeIdentity> = {},
): RuntimeIdentity {
  return {
    platform,
    appVersion: "3.10.2",
    appBuild: "3.10.2.6414",
    cliVersion: "0.16.5",
    cliSha256: OFFICIAL_CLI_SHA256,
    metadataSha256: `metadata-${platform}`,
    bundle: {
      runtime: "electron-node",
      entry: "zcode.cjs",
      platform,
      source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
    },
    ...overrides,
  };
}

describe("ZCode compatibility manifest", () => {
  test("maps macOS, Linux, and Windows to the same artifact and protocol", () => {
    for (const platform of ["darwin-arm64", "linux-x64", "win32-x64"]) {
      expect(assessCompatibility(identity(platform))).toMatchObject({
        status: "supported",
        cliIntegrity: "verified",
        expectedCliSha256: OFFICIAL_CLI_SHA256,
        hostArtifact: { id: "zcode-host-3.10.2" },
        hostProtocol: { id: "zcode-task-v1" },
      });
    }
  });

  test("treats app build and raw metadata hashes as diagnostics", () => {
    expect(assessCompatibility(identity("darwin-arm64", {
      appBuild: "different-build",
      metadataSha256: "different-metadata-hash",
    }))).toMatchObject({
      status: "supported",
      hostArtifact: { id: CURRENT_ZCODE_ARTIFACT.id },
      hostProtocol: { id: CURRENT_HOST_PROTOCOL.id },
    });
  });

  test("reports a modified CLI without rejecting a matching host candidate", () => {
    expect(assessCompatibility(identity("linux-arm64", { cliSha256: "modified" })))
      .toMatchObject({
        status: "supported",
        cliIntegrity: "modified",
        expectedCliSha256: OFFICIAL_CLI_SHA256,
        hostArtifact: { id: "zcode-host-3.10.2" },
      });
  });

  test("rejects old, future, or unknown CLI versions", () => {
    expect(assessCompatibility(identity("darwin-arm64", { appVersion: "0.0.0" })).status)
      .toBe("unsupported");
    expect(assessCompatibility(identity("darwin-arm64", { appVersion: "3.10.3" })).status)
      .toBe("unsupported");
    expect(assessCompatibility(identity("darwin-arm64", { cliVersion: "0.16.6" })).status)
      .toBe("unsupported");
  });
});
