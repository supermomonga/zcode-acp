import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });

const artifacts = [
  { target: "bun-darwin-arm64", output: join(dist, "zcode-acp-darwin-arm64") },
  { target: "bun-darwin-x64", output: join(dist, "zcode-acp-darwin-x64") },
  { target: "bun-linux-arm64", output: join(dist, "zcode-acp-linux-arm64") },
  { target: "bun-linux-x64", output: join(dist, "zcode-acp-linux-x64") },
  { target: "bun-windows-x64", output: join(dist, "zcode-acp-windows-x64.exe") },
] as const;

for (const artifact of artifacts) {
  const result = await Bun.build({
    entrypoints: [join(root, "src", "cli.ts")],
    compile: {
      target: artifact.target,
      outfile: artifact.output,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    throw new Error(`Build failed for ${artifact.target}`);
  }
}

const packageJson = await Bun.file(join(root, "package.json")).json() as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};
const dependencyPackages = await Promise.all(
  Object.entries(packageJson.dependencies).map(async ([name, requestedVersion]) => {
    const dependency = await Bun.file(join(root, "node_modules", name, "package.json")).json() as {
      version: string;
      license?: string;
    };
    return {
      SPDXID: `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]/g, "-")}`,
      name,
      versionInfo: dependency.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: dependency.license ?? "NOASSERTION",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:npm/${encodeURIComponent(name)}@${dependency.version}`,
      }],
      comment: `Bundled production dependency; package.json constraint ${requestedVersion}`,
    };
  }),
);
const rootSpdxId = "SPDXRef-Package-zcode-acp";
const sourceEpoch = Number(process.env.SOURCE_DATE_EPOCH);
const created = Number.isFinite(sourceEpoch) && sourceEpoch >= 0
  ? new Date(sourceEpoch * 1_000).toISOString()
  : new Date().toISOString();
const namespaceSeed = `${packageJson.name}@${packageJson.version}:${await sha256(join(root, "bun.lock"))}`;
const namespaceHash = new Bun.CryptoHasher("sha256").update(namespaceSeed).digest("hex");
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/supermomonga/zcode-acp/spdx/${namespaceHash}`,
  creationInfo: {
    created,
    creators: [`Tool: Bun-${Bun.version}`, `Organization: zcode-acp contributors`],
  },
  packages: [
    {
      SPDXID: rootSpdxId,
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
    },
    ...dependencyPackages,
  ],
  relationships: dependencyPackages.map((dependency) => ({
    spdxElementId: rootSpdxId,
    relationshipType: "DEPENDS_ON",
    relatedSpdxElement: dependency.SPDXID,
  })),
};
await Bun.write(join(dist, "sbom.spdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

const checksumFiles = (await readdir(dist))
  .filter((name) => name.startsWith("zcode-acp-") || name === "sbom.spdx.json")
  .sort();
const sums = await Promise.all(
  checksumFiles.map(async (name) => `${await sha256(join(dist, name))}  ${basename(name)}`),
);
await Bun.write(join(dist, "SHA256SUMS"), `${sums.join("\n")}\n`);
process.stdout.write(`${JSON.stringify({ artifacts: checksumFiles, checksums: "SHA256SUMS" })}\n`);

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}
