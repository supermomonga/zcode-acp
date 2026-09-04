import { describe, expect, test } from "bun:test";
import { createDoctorReport } from "../../src/cli/doctor-report.ts";
import {
  CURRENT_HOST_PROTOCOL,
  CURRENT_ZCODE_ARTIFACT,
} from "../../src/zcode/discovery/manifest.ts";
import type { DiscoveredRuntime } from "../../src/zcode/discovery/types.ts";

describe("doctor report", () => {
  test("reports host artifact and protocol separately", () => {
    const runtime: DiscoveredRuntime = {
      paths: {
        installRoot: "/opt/ZCode",
        executable: "/opt/ZCode/zcode",
        cliEntry: "/opt/ZCode/resources/glm/zcode.cjs",
        metadata: "/opt/ZCode/resources/glm/.node-bundle-meta.json",
        appPackage: "/opt/ZCode/resources/app.asar/package.json",
        hostArchive: "/opt/ZCode/resources/app.asar",
      },
      identity: {
        platform: "linux-x64",
        appVersion: "3.11.2",
        cliVersion: "0.16.5",
        cliSha256: CURRENT_ZCODE_ARTIFACT.cliSha256,
        metadataSha256: "metadata-hash",
        bundle: {
          runtime: "electron-node",
          entry: "zcode.cjs",
          platform: "linux-x64",
          source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
        },
      },
      expectedCliSha256: CURRENT_ZCODE_ARTIFACT.cliSha256,
      cliIntegrity: "verified",
      resolvedHost: {
        artifact: CURRENT_ZCODE_ARTIFACT,
        protocol: CURRENT_HOST_PROTOCOL,
        hostIndex: "/opt/ZCode/resources/app.asar/out/host/index.js",
        hostRpcModule: "/opt/ZCode/resources/app.asar/out/host/chunk-KGXW6KHC.js",
        hostIndexSha256: CURRENT_ZCODE_ARTIFACT.hostIndexSha256,
        hostRpcModuleSha256: CURRENT_ZCODE_ARTIFACT.hostRpcModuleSha256,
        rpcExports: ["g", "i", "j"],
      },
      compatibility: "supported",
      compatibilityReason: "verified",
      writableInstallRoot: false,
    };

    const report = createDoctorReport(runtime, {
      passed: true,
      cliVersion: "0.16.5",
      doctorPassed: true,
      authentication: "present",
    });

    expect(report).toMatchObject({
      hostArtifact: "zcode-host-3.11.2",
      hostProtocol: "zcode-task-v1",
      compatibility: "supported",
    });
    expect(report).not.toHaveProperty("hostContract");
  });
});
