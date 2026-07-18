#!/usr/bin/env bun

import { StderrLogger } from "./diagnostics/logger.ts";
import { safeError } from "./diagnostics/redaction.ts";
import { HeadlessZCodeSessionService } from "./domain/session-service.ts";
import { serveAcpStdio } from "./acp/v1/server.ts";
import { parseArguments } from "./cli/arguments.ts";
import {
  discoverRuntime,
  runBundledCliInteractive,
  runRuntimeSmoke,
} from "./zcode/discovery/discover.ts";
import { ACP_PROTOCOL_VERSION, ZCODE_ACP_VERSION } from "./version.ts";

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const discoveryOptions = {
    ...(args.zcodeInstall === undefined ? {} : { installRoot: args.zcodeInstall }),
    environment: process.env,
  };

  if (args.command === "agent") {
    const logger = new StderrLogger(process.env.ZCODE_ACP_LOG_LEVEL === "debug" ? "debug" : "info");
    await serveAcpStdio(new HeadlessZCodeSessionService(logger, discoveryOptions), logger);
    return 0;
  }

  if (args.command === "version") {
    let detected: { zcodeAppVersion?: string; zcodeCliVersion?: string } = {};
    try {
      const runtime = await discoverRuntime(discoveryOptions);
      detected = {
        ...(runtime.identity.appVersion === undefined
          ? {}
          : { zcodeAppVersion: runtime.identity.appVersion }),
        ...(runtime.identity.cliVersion === undefined
          ? {}
          : { zcodeCliVersion: runtime.identity.cliVersion }),
      };
    } catch {
      // Version remains useful when ZCode is not installed.
    }
    process.stdout.write(
      `zcode-acp ${ZCODE_ACP_VERSION}\nACP ${ACP_PROTOCOL_VERSION}\n` +
        (detected.zcodeAppVersion === undefined
          ? ""
          : `ZCode ${detected.zcodeAppVersion}\n`) +
        (detected.zcodeCliVersion === undefined
          ? ""
          : `ZCode CLI ${detected.zcodeCliVersion}\n`),
    );
    return 0;
  }

  if (args.command === "login" || args.command === "logout") {
    const runtime = await discoverRuntime(discoveryOptions);
    return await runBundledCliInteractive(
      runtime,
      args.command === "login" ? ["login", "--no-browser"] : ["logout"],
      process.env,
    );
  }

  const runtime = await discoverRuntime(discoveryOptions);
  const smoke = await runRuntimeSmoke(runtime);
  const report = {
    platform: runtime.identity.platform,
    zcodeInstall: runtime.paths.installRoot,
    zcodeAppVersion: runtime.identity.appVersion ?? null,
    zcodeBuild: runtime.identity.appBuild ?? null,
    zcodeCliVersion: runtime.identity.cliVersion ?? smoke.cliVersion ?? null,
    runtime: runtime.identity.bundle.runtime,
    cliSha256: runtime.identity.cliSha256,
    metadataSha256: runtime.identity.metadataSha256,
    compatibility: runtime.compatibility,
    compatibilityReason: runtime.compatibilityReason,
    runtimeSmoke: smoke.passed ? "passed" : "failed",
    authentication: smoke.authentication,
    providerHeadersBridge: "installed-host",
    installRootWritableByGroupOrOthers: runtime.writableInstallRoot,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [key, value] of Object.entries(report)) {
      process.stdout.write(`${key}: ${String(value)}\n`);
    }
  }
  return smoke.passed ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: "zcode-acp.failed", error: safeError(error) })}\n`);
  process.exitCode = 1;
}
