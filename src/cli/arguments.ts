import { isAbsolute } from "node:path";
import { AdapterError } from "../domain/errors.ts";

export type Command = "agent" | "doctor" | "version" | "login" | "logout";

export interface CliArguments {
  readonly command: Command;
  readonly json: boolean;
  readonly zcodeInstall?: string;
}

export function parseArguments(argv: readonly string[]): CliArguments {
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
