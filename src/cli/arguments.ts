import { isAbsolute } from "node:path";
import { AdapterError } from "../domain/errors.ts";

export type Command =
  | "agent"
  | "doctor"
  | "version"
  | "login"
  | "logout"
  | "paseo-serve"
  | "paseo-version"
  | "paseo-auth-list";

export interface CliArguments {
  readonly command: Command;
  readonly json: boolean;
  readonly zcodeInstall?: string;
  readonly port?: number;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv[0] === "paseo") {
    return parsePaseoArguments(argv.slice(1));
  }
  let command: Command = "agent";
  let json = false;
  let zcodeInstall: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "doctor" || argument === "version" || argument === "login" || argument === "logout") {
      if (command !== "agent") {
        throw new AdapterError("INVALID_CONFIGURATION", "Only one command may be specified");
      }
      command = argument;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--zcode-install") {
      const value = argv[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "--zcode-install requires an absolute path",
        );
      }
      zcodeInstall = value;
      index += 1;
      continue;
    }
    throw new AdapterError("INVALID_CONFIGURATION", `Unknown argument: ${String(argument)}`);
  }

  if (json && command !== "doctor") {
    throw new AdapterError("INVALID_CONFIGURATION", "--json is only valid with doctor");
  }

  return {
    command,
    json,
    ...(zcodeInstall === undefined ? {} : { zcodeInstall }),
  };
}

function parsePaseoArguments(argv: readonly string[]): CliArguments {
  let zcodeInstall: string | undefined;
  let port: number | undefined;
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--zcode-install") {
      const value = argv[index + 1];
      if (value === undefined || !isAbsolute(value)) {
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "--zcode-install requires an absolute path",
        );
      }
      zcodeInstall = value;
      index += 1;
      continue;
    }
    if (argument === "--port") {
      const value = argv[index + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new AdapterError(
          "INVALID_CONFIGURATION",
          "--port must be an integer from 1 to 65535",
        );
      }
      port = parsed;
      index += 1;
      continue;
    }
    positional.push(argument ?? "");
  }

  let command: Command;
  if (positional.length === 1 && positional[0] === "--version") {
    command = "paseo-version";
  } else if (positional.length === 2 && positional[0] === "auth" && positional[1] === "list") {
    command = "paseo-auth-list";
  } else if (positional.length === 1 && positional[0] === "serve" && port !== undefined) {
    command = "paseo-serve";
  } else {
    throw new AdapterError(
      "INVALID_CONFIGURATION",
      "Expected 'paseo --version', 'paseo auth list', or 'paseo serve --port <port>'",
    );
  }

  return {
    command,
    json: false,
    ...(zcodeInstall === undefined ? {} : { zcodeInstall }),
    ...(port === undefined ? {} : { port }),
  };
}
