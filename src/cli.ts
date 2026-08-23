#!/usr/bin/env bun

import { StderrLogger } from "./diagnostics/logger.ts";
import { safeError } from "./diagnostics/redaction.ts";
import { HeadlessZCodeSessionService } from "./acp/v1/session-service.ts";
import { serveAcpStdio } from "./acp/v1/server.ts";
import { parseArguments } from "./cli/arguments.ts";
import {
  createPaseoEngine,
  PASEO_OPENCODE_SDK_VERSION,
  startPaseoOpenCodeServer,
} from "./paseo/opencode/server.ts";
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
    await serveAcpStdio(HeadlessZCodeSessionService.create(logger, discoveryOptions), logger);
    return 0;
  }

  if (args.command === "paseo-version") {
    process.stdout.write(
      `zcode-acp paseo ${ZCODE_ACP_VERSION} (OpenCode SDK ${PASEO_OPENCODE_SDK_VERSION})\n`,
    );
    return 0;
  }

  if (args.command === "paseo-auth-list") {
    const runtime = await discoverRuntime(discoveryOptions);
    const smoke = await runRuntimeSmoke(runtime);
    if (!smoke.passed || smoke.authentication !== "present") {
      process.stdout.write("ZCode: unauthenticated (run zcode-acp login)\n");
      return 1;
    }
    process.stdout.write("ZCode: authenticated\n");
    return 0;
  }

  if (args.command === "paseo-serve") {
    const logger = new StderrLogger(process.env.ZCODE_ACP_LOG_LEVEL === "debug" ? "debug" : "info");
    const server = startPaseoOpenCodeServer({
      port: args.port!,
      logger,
      engine: createPaseoEngine(logger, discoveryOptions),
    });
    process.stdout.write(`listening on http://127.0.0.1:${server.port}\n`);
    await waitForShutdownSignal();
    await server.stop();
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
    expectedCliSha256: runtime.expectedCliSha256 ?? null,
    cliIntegrity: runtime.cliIntegrity ?? null,
    metadataSha256: runtime.identity.metadataSha256,
    hostContract: runtime.hostContract?.descriptor.id ?? null,
    hostIndexSha256: runtime.hostContract?.hostIndexSha256 ?? null,
    hostRpcModuleSha256: runtime.hostContract?.hostRpcModuleSha256 ?? null,
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

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: "zcode-acp.failed", error: safeError(error) })}\n`);
  process.exitCode = 1;
}
