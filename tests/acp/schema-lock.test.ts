import { describe, expect, test } from "bun:test";
import manifest from "../../schemas/manifest.json";

describe("ACP schema lock", () => {
  test("pins protocol v1 schema 1.19.0 and the SDK schema independently", async () => {
    expect(manifest.acpProtocolVersion).toBe(1);
    expect(manifest.officialSchema.release).toBe("schema-v1.19.0");
    expect(manifest.officialSchema.sha256).toBe(
      "92c1dfcda10dd47e99127500a3763da2b471f9ac61e12b9bf0430c32cf953796",
    );

    const schema = Bun.file(
      new URL("../../node_modules/@agentclientprotocol/sdk/schema/schema.json", import.meta.url),
    );
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await schema.arrayBuffer());
    expect(hasher.digest("hex")).toBe(manifest.typescriptSdk.bundledSchemaSha256);
  });
});
