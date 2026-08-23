import { access, constants, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { AdapterError } from "../../domain/errors.ts";
import {
  hostContractMismatch,
  resolveHostContractPaths,
} from "./host-contract.ts";
import { assessCompatibility } from "./manifest.ts";
import type {
  BundleMetadata,
  DiscoveredRuntime,
  HostContractDescriptor,
  RuntimeIdentity,
  RuntimePaths,
  RuntimeSmokeResult,
} from "./types.ts";

const BundleMetadataSchema = z
  .object({
    runtime: z.literal("electron-node"),
    entry: z.string().min(1),
    platform: z.string().min(1),
    source: z.string().min(1),
  })
  .strict();

export interface DiscoveryOptions {
  readonly installRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

export async function discoverRuntime(
  options: DiscoveryOptions = {},
): Promise<DiscoveredRuntime> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const configuredRoot =
    options.installRoot ?? options.environment?.ZCODE_ACP_ZCODE_INSTALL ?? defaultInstallRoot(platform);

  if (!isAbsolute(configuredRoot)) {
    throw new AdapterError("INVALID_CONFIGURATION", "ZCode install root must be absolute");
  }

  let installRoot: string;
  try {
    installRoot = await realpath(configuredRoot);
  } catch (error) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "ZCode install root does not exist",
      { configuredRoot },
      { cause: error },
    );
  }

  const paths = runtimePaths(installRoot, platform);
  await validatePaths(paths);

  const bundle = BundleMetadataSchema.parse(await Bun.file(paths.metadata).json()) as BundleMetadata;
  if (bundle.entry !== paths.cliEntry.split(sep).at(-1)) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Bundle entry does not match the resolved CLI entry",
    );
  }

  const detectedPlatform = `${platform}-${architecture}`;
  if (bundle.platform !== detectedPlatform) {
    throw new AdapterError(
      "UNSUPPORTED_PLATFORM",
      "ZCode bundle platform does not match the current process",
      { detectedPlatform, bundlePlatform: bundle.platform },
    );
  }

  const [cliSha256, metadataSha256, app] = await Promise.all([
    sha256(paths.cliEntry),
    sha256(paths.metadata),
    readAppIdentity(paths, platform),
  ]);
  const cliVersion = await readCliVersion(paths);

  const identity: RuntimeIdentity = {
    platform: detectedPlatform,
    ...(app.version === undefined ? {} : { appVersion: app.version }),
    ...(app.build === undefined ? {} : { appBuild: app.build }),
    ...(cliVersion === undefined ? {} : { cliVersion }),
    cliSha256,
    metadataSha256,
    bundle,
  };
  const assessment = assessCompatibility(identity);
  const host = assessment.hostContract === undefined
    ? undefined
    : await resolveHostContract(
        paths,
        assessment.hostContract,
        options.environment ?? process.env,
      );
  const hostMismatch = host === undefined
    ? undefined
    : hostContractMismatch(assessment.hostContract!, {
        hostIndexSha256: host.hostIndexSha256,
        hostRpcModuleSha256: host.hostRpcModuleSha256,
        exports: host.rpcExports,
      });
  const rootStat = await stat(installRoot);

  return {
    paths,
    identity,
    ...(host === undefined ? {} : { hostContract: host }),
    compatibility: hostMismatch === undefined ? assessment.status : "unsupported",
    compatibilityReason: hostMismatch ?? assessment.reason,
    writableInstallRoot: (rootStat.mode & 0o022) !== 0,
  };
}

export async function runRuntimeSmoke(
  runtime: DiscoveredRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeSmokeResult> {
  try {
    const version = await runBundledCliCommand(runtime.paths, ["version"], environment);
    const doctor = await runBundledCliCommand(runtime.paths, ["doctor", "--json"], environment);
    const authentication = await inferAuthenticationPresence(environment);
    return {
      passed: version.exitCode === 0 && doctor.exitCode === 0,
      ...(runtime.identity.cliVersion === undefined
        ? {}
        : { cliVersion: runtime.identity.cliVersion }),
      doctorPassed: doctor.exitCode === 0,
      authentication,
      ...(version.exitCode === 0 && doctor.exitCode === 0
        ? {}
        : { error: "Bundled version or doctor command failed" }),
    };
  } catch (error) {
    return {
      passed: false,
      doctorPassed: false,
      authentication: "unknown",
      error: error instanceof Error ? error.message : "Runtime smoke failed",
    };
  }
}

export function assertRuntimeSupported(runtime: DiscoveredRuntime): void {
  if (runtime.compatibility !== "supported") {
    throw new AdapterError("UNSUPPORTED_ZCODE", runtime.compatibilityReason, {
      platform: runtime.identity.platform,
      appVersion: runtime.identity.appVersion,
      appBuild: runtime.identity.appBuild,
      cliVersion: runtime.identity.cliVersion,
      compatibility: runtime.compatibility,
      hostContract: runtime.hostContract?.descriptor.id,
    });
  }
}

export async function runBundledCliInteractive(
  runtime: DiscoveredRuntime,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  assertRuntimeSupported(runtime);
  const child = Bun.spawn([runtime.paths.executable, runtime.paths.cliEntry, ...args], {
    cwd: process.cwd(),
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

function defaultInstallRoot(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/Applications/ZCode.app";
    case "linux":
      return "/opt/ZCode";
    case "win32":
      return "C:\\Program Files\\ZCode";
    default:
      throw new AdapterError("UNSUPPORTED_PLATFORM", `Unsupported platform: ${platform}`);
  }
}

function runtimePaths(installRoot: string, platform: NodeJS.Platform): RuntimePaths {
  if (platform === "darwin") {
    return {
      installRoot,
      executable: join(
        installRoot,
        "Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper",
      ),
      cliEntry: join(installRoot, "Contents/Resources/glm/zcode.cjs"),
      metadata: join(installRoot, "Contents/Resources/glm/.node-bundle-meta.json"),
      appMetadata: join(installRoot, "Contents/Info.plist"),
      appPackage: join(installRoot, "Contents/Resources/app.asar/package.json"),
      hostArchive: join(installRoot, "Contents/Resources/app.asar"),
    };
  }

  if (platform === "linux") {
    return {
      installRoot,
      executable: join(installRoot, "zcode"),
      cliEntry: join(installRoot, "resources/glm/zcode.cjs"),
      metadata: join(installRoot, "resources/glm/.node-bundle-meta.json"),
      appPackage: join(installRoot, "resources/app.asar/package.json"),
      hostArchive: join(installRoot, "resources/app.asar"),
    };
  }

  if (platform === "win32") {
    return {
      installRoot,
      executable: join(installRoot, "ZCode.exe"),
      cliEntry: join(installRoot, "resources/glm/zcode.cjs"),
      metadata: join(installRoot, "resources/glm/.node-bundle-meta.json"),
      appPackage: join(installRoot, "resources/app.asar/package.json"),
      hostArchive: join(installRoot, "resources/app.asar"),
    };
  }

  throw new AdapterError("UNSUPPORTED_PLATFORM", `Unsupported platform: ${platform}`);
}

async function validatePaths(paths: RuntimePaths): Promise<void> {
  for (const path of [
    paths.executable,
    paths.cliEntry,
    paths.metadata,
    paths.hostArchive,
  ]) {
    ensureInsideInstallRoot(paths.installRoot, path);
    await access(path, constants.R_OK);
  }
  await access(paths.executable, constants.X_OK);
}

function ensureInsideInstallRoot(root: string, path: string): void {
  const child = relative(root, path);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Resolved runtime path is outside the install root",
    );
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function resolveHostContract(
  paths: RuntimePaths,
  descriptor: HostContractDescriptor,
  environment: NodeJS.ProcessEnv,
): Promise<NonNullable<DiscoveredRuntime["hostContract"]>> {
  const { hostIndex, hostRpcModule } = resolveHostContractPaths(
    paths.installRoot,
    paths.hostArchive,
    descriptor,
  );

  const script = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const hash = path => crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
(async () => {
  const rpc = await import(pathToFileURL(${JSON.stringify(hostRpcModule)}).href);
  process.stdout.write(JSON.stringify({
    hostIndexSha256: hash(${JSON.stringify(hostIndex)}),
    hostRpcModuleSha256: hash(${JSON.stringify(hostRpcModule)}),
    exports: Object.keys(rpc),
  }));
})().catch(error => {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});`;
  const child = Bun.spawn([paths.executable, "-e", script], {
    cwd: paths.installRoot,
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new AdapterError(
      "RUNTIME_DISCOVERY_FAILED",
      "Failed to inspect the manifest-selected ZCode host contract",
      { contract: descriptor.id, exitCode, stderr: stderr.slice(-1_000) },
    );
  }

  const inspection = z.object({
    hostIndexSha256: z.string().regex(/^[0-9a-f]{64}$/),
    hostRpcModuleSha256: z.string().regex(/^[0-9a-f]{64}$/),
    exports: z.array(z.string()),
  }).strict().parse(JSON.parse(stdout));
  return {
    descriptor,
    hostIndex,
    hostRpcModule,
    hostIndexSha256: inspection.hostIndexSha256,
    hostRpcModuleSha256: inspection.hostRpcModuleSha256,
    rpcExports: inspection.exports,
  };
}

async function readAppIdentity(
  paths: RuntimePaths,
  platform: NodeJS.Platform,
): Promise<{ version?: string; build?: string }> {
  const [packageVersion, plistVersion, build] = await Promise.all([
    readAsarPackageVersion(paths),
    platform === "darwin" && paths.appMetadata !== undefined
      ? plutilValue(paths.appMetadata, "CFBundleShortVersionString")
      : undefined,
    platform === "darwin" && paths.appMetadata !== undefined
      ? plutilValue(paths.appMetadata, "CFBundleVersion")
      : undefined,
  ]);
  const version = plistVersion ?? packageVersion;
  return {
    ...(version === undefined ? {} : { version }),
    ...(build === undefined ? {} : { build }),
  };
}

async function readAsarPackageVersion(paths: RuntimePaths): Promise<string | undefined> {
  const script = `const value=require(${JSON.stringify(paths.appPackage)});` +
    'if(typeof value.version!=="string")process.exit(2);process.stdout.write(value.version)';
  const child = Bun.spawn([paths.executable, "-e", script], {
    cwd: paths.installRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? stdout.trim() || undefined : undefined;
}

async function plutilValue(path: string, key: string): Promise<string | undefined> {
  const process = Bun.spawn(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", path], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(process.stdout).text();
  return (await process.exited) === 0 ? stdout.trim() || undefined : undefined;
}

async function readCliVersion(paths: RuntimePaths): Promise<string | undefined> {
  const result = await runBundledCliCommand(paths, ["version"], process.env);
  if (result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
}

export async function runBundledCliCommand(
  paths: RuntimePaths,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn([paths.executable, paths.cliEntry, ...args], {
    cwd: paths.installRoot,
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  return { exitCode, stdout };
}

async function inferAuthenticationPresence(
  environment: NodeJS.ProcessEnv,
): Promise<"present" | "missing" | "unknown"> {
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) {
    return "unknown";
  }

  try {
    const credentials = await stat(join(home, ".zcode", "v2", "credentials.json"));
    return credentials.isFile() && credentials.size > 0 ? "present" : "missing";
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return "missing";
    }
    return "unknown";
  }
}
