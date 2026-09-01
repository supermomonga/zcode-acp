import { describe, expect, test } from "bun:test";
import { parseArguments } from "../../src/cli/arguments.ts";

describe("CLI arguments", () => {
  test("defaults to ACP agent mode", () => {
    expect(parseArguments([])).toEqual({ command: "agent", json: false });
  });

  test("accepts doctor JSON and an absolute install root", () => {
    expect(parseArguments(["doctor", "--json", "--zcode-install", "/opt/ZCode"])).toEqual({
      command: "doctor",
      json: true,
      zcodeInstall: "/opt/ZCode",
    });
  });

  test("rejects unknown arguments", () => {
    expect(() => parseArguments(["--fallback-node"])).toThrow("Unknown argument");
  });

  test("accepts explicit version, login, and logout commands", () => {
    expect(parseArguments(["version"])).toEqual({ command: "version", json: false });
    expect(parseArguments(["login"])).toEqual({ command: "login", json: false });
    expect(parseArguments(["logout"])).toEqual({ command: "logout", json: false });
  });

  test("rejects the removed non-ACP command surface", () => {
    for (const args of [
      ["paseo", "--version"],
      ["paseo", "auth", "list"],
      ["paseo", "serve", "--port", "4096"],
    ]) {
      expect(() => parseArguments(args)).toThrow("Unknown argument: paseo");
    }
  });
});
