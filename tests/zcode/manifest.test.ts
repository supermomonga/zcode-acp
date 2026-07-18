import { describe, expect, test } from "bun:test";
import { assessCompatibility } from "../../src/zcode/discovery/manifest.ts";

describe("ZCode compatibility manifest", () => {
  test("recognizes the release-gated investigated artifact", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.3.6",
        appBuild: "3.3.6.3198",
        cliVersion: "0.15.2",
        cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
        metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toEqual({
      status: "supported",
      reason: "All compatibility release gates passed",
    });
  });

  test("rejects a same-version artifact with a different hash", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.3.6",
        appBuild: "3.3.6.3198",
        cliVersion: "0.15.2",
        cliSha256: "different",
        metadataSha256: "different",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }).status,
    ).toBe("unsupported");
  });

  test("recognizes the release-gated Linux package", () => {
    expect(
      assessCompatibility({
        platform: "linux-x64",
        appVersion: "3.3.6",
        cliVersion: "0.15.2",
        cliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
        metadataSha256: "3d0fccf8be60268be3749913f683a5e7e0f8c6e0719d32cc41e3d272b8436f51",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "linux-x64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toEqual({
      status: "supported",
      reason: "All compatibility release gates passed",
    });
  });
});
