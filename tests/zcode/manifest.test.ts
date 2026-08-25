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
    ).toMatchObject({
      status: "supported",
      reason: "All host compatibility release gates passed and the CLI artifact is verified",
      expectedCliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
      cliIntegrity: "verified",
      hostContract: { id: "zcode-host-3.3.6" },
    });
  });

  test("accepts a same-version modified CLI while reporting its integrity", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.3.6",
        appBuild: "3.3.6.3198",
        cliVersion: "0.15.2",
        cliSha256: "different",
        metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toMatchObject({
      status: "supported",
      cliIntegrity: "modified",
      expectedCliSha256: "a79671db61cb51124fe53c1e3e21acd1359d26dc4e6abbd05a39eedb70adc239",
      hostContract: { id: "zcode-host-3.3.6" },
    });
  });

  test("rejects an unknown CLI version or metadata hash", () => {
    const identity = {
      platform: "darwin-arm64",
      appVersion: "3.8.1",
      appBuild: "3.8.1.5310",
      cliVersion: "0.16.3",
      cliSha256: "modified",
      metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
      bundle: {
        runtime: "electron-node" as const,
        entry: "zcode.cjs",
        platform: "darwin-arm64",
        source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
      },
    };
    expect(assessCompatibility({ ...identity, cliVersion: "0.16.4" }).status)
      .toBe("unsupported");
    expect(assessCompatibility({ ...identity, metadataSha256: "different" }).status)
      .toBe("unsupported");
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
    ).toMatchObject({
      status: "supported",
      cliIntegrity: "verified",
      hostContract: { id: "zcode-host-3.3.6" },
    });
  });

  test("recognizes the release-gated ZCode 3.8.1 macOS artifact", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.8.1",
        appBuild: "3.8.1.5310",
        cliVersion: "0.16.3",
        cliSha256: "9318f60fb8c2c3bc83ce62da10220ebcdc9a99786df0a9abb1a4435ba66e4274",
        metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toMatchObject({
      status: "supported",
      cliIntegrity: "verified",
      hostContract: {
        id: "zcode-host-3.8.1",
        hostRpcModuleRelativePath: "out/host/chunk-LVLFJXEE.js",
      },
    });
  });

  test("recognizes the locally modified ZCode 3.8.1 CLI by its reported version", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.8.1",
        appBuild: "3.8.1.5310",
        cliVersion: "0.16.3",
        cliSha256: "c96bd4acbffcbf239f9601944bde4099034e655dff011ef7421965ea0d03c917",
        metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toMatchObject({
      status: "supported",
      cliIntegrity: "modified",
      expectedCliSha256: "9318f60fb8c2c3bc83ce62da10220ebcdc9a99786df0a9abb1a4435ba66e4274",
      hostContract: { id: "zcode-host-3.8.1" },
    });
  });

  test("recognizes the release-gated ZCode 3.9.1 macOS artifact", () => {
    expect(
      assessCompatibility({
        platform: "darwin-arm64",
        appVersion: "3.9.1",
        appBuild: "3.9.1.5853",
        cliVersion: "0.16.5",
        cliSha256: "427ac6862771e29533ec69a3e9d801964cad98226463617ba461cc310bf6a850",
        metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "darwin-arm64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      }),
    ).toMatchObject({
      status: "supported",
      cliIntegrity: "verified",
      expectedCliSha256: "427ac6862771e29533ec69a3e9d801964cad98226463617ba461cc310bf6a850",
      hostContract: {
        id: "zcode-host-3.9.1",
        hostRpcModuleRelativePath: "out/host/chunk-KGXW6KHC.js",
      },
    });
  });

  test("reports a modified ZCode 3.9.1 CLI without broadening artifact matching", () => {
    const identity = {
      platform: "darwin-arm64",
      appVersion: "3.9.1",
      appBuild: "3.9.1.5853",
      cliVersion: "0.16.5",
      cliSha256: "modified",
      metadataSha256: "3cb76cfe74da2c647e077cbd35a0868034769ca04212f5ef8ac87fccb8ba4660",
      bundle: {
        runtime: "electron-node" as const,
        entry: "zcode.cjs",
        platform: "darwin-arm64",
        source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
      },
    };

    expect(assessCompatibility(identity)).toMatchObject({
      status: "supported",
      cliIntegrity: "modified",
      expectedCliSha256: "427ac6862771e29533ec69a3e9d801964cad98226463617ba461cc310bf6a850",
      hostContract: { id: "zcode-host-3.9.1" },
    });
    expect(assessCompatibility({ ...identity, appBuild: "3.9.1.5854" }).status)
      .toBe("unsupported");
    expect(assessCompatibility({ ...identity, metadataSha256: "different" }).status)
      .toBe("unsupported");
  });
});
