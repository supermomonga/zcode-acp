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

  test("accepts explicit ZCode login and logout commands", () => {
    expect(parseArguments(["login"])).toEqual({ command: "login", json: false });
    expect(parseArguments(["logout"])).toEqual({ command: "logout", json: false });
  });

  test("accepts the Paseo OpenCode-compatible command surface", () => {
    expect(parseArguments(["paseo", "--version"])).toEqual({
      command: "paseo-version",
      json: false,
    });
    expect(parseArguments(["paseo", "auth", "list"])).toEqual({
      command: "paseo-auth-list",
      json: false,
    });
    expect(parseArguments(["paseo", "serve", "--port", "4096"])).toEqual({
      command: "paseo-serve",
      json: false,
      port: 4096,
    });
  });

  test("rejects a missing or unsafe Paseo port", () => {
    expect(() => parseArguments(["paseo", "serve"])).toThrow();
    expect(() => parseArguments(["paseo", "serve", "--port", "0"])).toThrow();
    expect(() => parseArguments(["paseo", "serve", "--port", "65536"])).toThrow();
  });
});
