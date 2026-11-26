/**
 * Error codes and exit codes of the `orbitrace` command. docs/cli.md lists the same table; a
 * test checks that the two agree.
 *
 * The codes `not-found`, `unreadable`, `invalid` and `internal` are core's `TransportErrorCode`
 * values, passed on unchanged from a `SessionReplayError`. The others belong to the command line.
 *
 * Every message is written here or in core, never copied from an underlying error: a Node file
 * error names the absolute path it failed on. A message may only show a path the user typed.
 */

import { ReplayValidationError, SessionReplayError } from "@orbitrace/core";

/** Stable error codes, with the process exit code of each. */
export const CLI_EXIT_CODES = {
  /** Something unexpected went wrong. */
  internal: 1,
  /** The command line could not be understood: unknown command or option, missing value. */
  usage: 2,
  /** No session has the key that was given. */
  "not-found": 3,
  /** `--latest` was given and no session was found at all. */
  "no-sessions": 4,
  /** The key prefix that was given matches more than one session. */
  ambiguous: 5,
  /** The session transcript could not be read. */
  unreadable: 6,
  /** The replay built from the session did not pass the replay format check. */
  invalid: 7,
  /** The output file exists and `--force` was not given. */
  "output-exists": 8,
  /** The output file could not be written. */
  "output-unwritable": 9,
} as const;

export type CliErrorCode = keyof typeof CLI_EXIT_CODES;

/** Every error code, in exit code order. */
export const CLI_ERROR_CODES = Object.keys(CLI_EXIT_CODES) as CliErrorCode[];

/** Exit code of a successful run. */
export const EXIT_OK = 0;

/** Message used for any failure that is not a known error. Fixed text, so no path can leak. */
export const INTERNAL_MESSAGE =
  "Something went wrong. Run the command again; if it keeps failing, open an issue.";

/** A failure with a stable code. `hint` is an optional second line saying what to try. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint: string | undefined;

  constructor(code: CliErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }

  get exitCode(): number {
    return CLI_EXIT_CODES[this.code];
  }
}

/** Shorthand for a usage error, which always points at the help. */
export function usageError(message: string, command?: string): CliError {
  const help = command === undefined ? "orbitrace --help" : `orbitrace ${command} --help`;
  return new CliError("usage", message, `Run '${help}' to see the usage.`);
}

/**
 * The `CliError` for anything thrown. A `CliError` is kept. A `SessionReplayError` keeps core's
 * code and core's path-free message. A `ReplayValidationError` from export becomes `invalid` with
 * its problem lines, which name a JSON pointer and a rule and never quote a value. Anything else
 * becomes `internal` with a fixed message.
 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof SessionReplayError) {
    switch (error.code) {
      case "not-found":
        return new CliError(
          "not-found",
          error.message,
          "Run 'orbitrace list' to see the session keys.",
        );
      case "unreadable":
        return new CliError("unreadable", error.message);
      case "invalid":
        return new CliError("invalid", error.message);
      default:
        return new CliError("internal", error.message);
    }
  }
  if (error instanceof ReplayValidationError) {
    const problems = error.problems.map((line) => `- ${line}`).join("\n");
    return new CliError(
      "invalid",
      `The replay did not pass the replay format check.${problems === "" ? "" : `\n${problems}`}`,
    );
  }
  return new CliError("internal", INTERNAL_MESSAGE);
}

/** The JSON object written to stderr under `--json`. */
export interface CliErrorJson {
  readonly error: {
    readonly code: CliErrorCode;
    readonly exitCode: number;
    readonly message: string;
    readonly hint?: string;
  };
}

export function errorToJson(error: CliError): CliErrorJson {
  return {
    error: {
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    },
  };
}

/** The lines written to stderr without `--json`. */
export function errorToText(error: CliError): string {
  const lines = [`orbitrace: ${error.message} [${error.code}]`];
  if (error.hint !== undefined) lines.push(error.hint);
  return `${lines.join("\n")}\n`;
}
