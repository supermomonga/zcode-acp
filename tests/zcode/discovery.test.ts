import { describe, expect, test } from "bun:test";
import {
  resolveRuntimePaths,
  validateBundleMetadata,
} from "../../src/zcode/discovery/discover.ts";

const metadata = {
  runtime: "electron-node",
  entry: "zcode.cjs",
  platform: "linux-x64",
  source: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
} as const;

describe("ZCode bundle metadata", () => {
  test("accepts the exact semantic fields for the current process", () => {
    expect(validateBundleMetadata(metadata, "linux-x64")).toEqual(metadata);
  });

  test("rejects a bundle for another platform", () => {
    expect(() => validateBundleMetadata(metadata, "darwin-arm64"))
      .toThrow("ZCode bundle platform does not match the current process");
  });

  test("rejects changed runtime, entry, source, or additional fields", () => {
    for (const candidate of [
      { ...metadata, runtime: "node" },
      { ...metadata, entry: "other.cjs" },
      { ...metadata, source: "other/source.cjs" },
      { ...metadata, extra: true },
    ]) {
      expect(() => validateBundleMetadata(candidate, "linux-x64")).toThrow();
    }
  });

  test("rejects an unknown operating system while resolving the install layout", () => {
    expect(() => resolveRuntimePaths("/opt/ZCode", "freebsd"))
      .toThrow("Unsupported platform: freebsd");
  });
});
