import { describe, expect, test } from "bun:test";
import manifest from "../../schemas/manifest.json";

describe("ACP schema lock", () => {
  test("pins protocol v1 schema 1.21.0 and the SDK schema independently", async () => {
    expect(manifest.acpProtocolVersion).toBe(1);
    expect(manifest.officialSchema.release).toBe("schema-v1.21.0");
    expect(manifest.officialSchema.sha256).toBe(
      "caf62ff962ada396878372ced11efb2c6764e59d90919a38583c319948931a42",
    );
    expect(manifest.typescriptSdk.version).toBe("1.4.0");
    expect(manifest.typescriptSdk.bundledSchemaSha256).toBe(
      "7f77702b34e0a0558e77220e9007bf8ee161a976bb8ac5021aba1b7e7b2c5708",
    );

    const schema = Bun.file(
      new URL("../../node_modules/@agentclientprotocol/sdk/schema/schema.json", import.meta.url),
    );
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await schema.arrayBuffer());
    expect(hasher.digest("hex")).toBe(manifest.typescriptSdk.bundledSchemaSha256);
  });
});
