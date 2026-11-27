/**
 * Command line parsing for `orbitrace`, on Node's `util.parseArgs`. The command specs below are
 * the single source for parsing, for the help text and for `orbitrace help --json`.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  isRoundTimesStep,
  ROUND_TIMES_MAX_STEP,
  ROUND_TIMES_MIN_STEP,
  type ExportNames,
} from "@orbitrace/core";
import { usageError } from "./errors.js";

export interface OptionSpec {
  readonly name: string;
  readonly short?: string;
  readonly type: "boolean" | "string";
  /** May be given more than once. */
  readonly multiple?: boolean;
  /** Placeholder shown in the help, for string options. */
  readonly value?: string;
  readonly description: string;
}

export interface ArgumentSpec {
  readonly name: string;
  readonly optional: boolean;
  readonly description: string;
}

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
  readonly usage: string;
  readonly arguments: readonly ArgumentSpec[];
  readonly options: readonly OptionSpec[];
}

export const COMMAND_NAMES = ["open", "list", "export", "doctor", "help"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Sessions the `doctor` parser check reads, newest first, without `--parse-limit`. */
export const DOCTOR_DEFAULT_PARSE_LIMIT = 20;

const JSON_OPTION: OptionSpec = {
  name: "json",
  type: "boolean",
  description: "Write one JSON document to stdout and errors as JSON to stderr.",
};

const HELP_OPTION: OptionSpec = {
  name: "help",
  short: "h",
  type: "boolean",
  description: "Show help for this command.",
};

/** Options accepted before any command. */
export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  { ...HELP_OPTION, description: "Show this help." },
  { name: "version", short: "V", type: "boolean", description: "Print the version." },
  JSON_OPTION,
];

const SOURCE_OPTIONS: readonly OptionSpec[] = [
  {
    name: "config-dir",
    type: "string",
    multiple: true,
    value: "path",
    description:
      "A Claude Code config folder (the one that holds projects/). Searched first. May be given more than once.",
  },
  {
    name: "extra-roots",
    type: "boolean",
    description: "Also search the desktop app's own session folders.",
  },
];

export const COMMANDS: Readonly<Record<CommandName, CommandSpec>> = {
  open: {
    name: "open",
    summary: "Open a session in your browser through a local server. The default command.",
    usage:
      "orbitrace open [<session-key> | --latest] [--no-browser] [--port <n>] [--config-dir <path>]... [--extra-roots] [--json]",
    arguments: [
      {
        name: "session-key",
        optional: true,
        description:
          "Key from 'orbitrace list', or a unique start of it. Without a key or --latest, the newest session opens, or the session list when there is none.",
      },
    ],
    options: [
      {
        name: "latest",
        type: "boolean",
        description: "Open the session with the newest activity; fail when there is none.",
      },
      {
        name: "no-browser",
        type: "boolean",
        description: "Print the link only; do not open a browser.",
      },
      {
        name: "port",
        type: "string",
        value: "n",
        description: "Listen on this port of 127.0.0.1 (1-65535). Default: a free port.",
      },
      ...SOURCE_OPTIONS,
      JSON_OPTION,
      HELP_OPTION,
    ],
  },
  list: {
    name: "list",
    summary: "List sessions, newest first.",
    usage: "orbitrace list [--config-dir <path>]... [--extra-roots] [--limit <n>] [--json]",
    arguments: [],
    options: [
      ...SOURCE_OPTIONS,
      {
        name: "limit",
        type: "string",
        value: "n",
        description: "Show at most n sessions.",
      },
      JSON_OPTION,
      HELP_OPTION,
    ],
  },
  export: {
    name: "export",
    summary: "Export a structure-only replay of one session.",
    usage:
      "orbitrace export (<session-key> | --latest) [-o <file>] [--force] [--pretty] [--opaque-names] [--round-times <seconds>] [--bucket-tokens] [--config-dir <path>]... [--extra-roots] [--json]",
    arguments: [
      {
        name: "session-key",
        optional: true,
        description:
          "Key from 'orbitrace list', or a unique start of it (at least 4 characters of the part after 'claude-code:').",
      },
    ],
    options: [
      {
        name: "latest",
        type: "boolean",
        description: "Export the session with the newest activity.",
      },
      {
        name: "output",
        short: "o",
        type: "string",
        value: "file",
        description:
          "Write to this file instead of stdout. A folder gets orbitrace.replay.json inside it. '-' means stdout.",
      },
      {
        name: "force",
        type: "boolean",
        description: "Replace the output file if it exists.",
      },
      {
        name: "pretty",
        type: "boolean",
        description: "Indent the JSON for reading.",
      },
      {
        name: "opaque-names",
        type: "boolean",
        description:
          "Write agent types as agent-1, agent-2, ..., MCP servers as mcp:server-1, ..., tool names that are not built in as tool_1, ..., and model ids that are not known Claude ids as null. Does not hide structure, counts, times or token counts.",
      },
      {
        name: "round-times",
        type: "string",
        value: "seconds",
        description:
          "Round every time to this step, for example 0.1 (0.001 to 3600, whole milliseconds). Hides exact durations; the order and rough length of everything stay.",
      },
      {
        name: "bucket-tokens",
        type: "boolean",
        description:
          "Write each reply's token counts as the nearest of 1, 2, 5, 10, 20, 50, ...; totals are the sums of those. Hides exact sizes, not rough ones.",
      },
      ...SOURCE_OPTIONS,
      JSON_OPTION,
      HELP_OPTION,
    ],
  },
  doctor: {
    name: "doctor",
    summary: "Check the set-up: say what is wrong and how to fix it. Changes nothing.",
    usage: "orbitrace doctor [--config-dir <path>]... [--extra-roots] [--parse-limit <n>] [--json]",
    arguments: [],
    options: [
      ...SOURCE_OPTIONS,
      {
        name: "parse-limit",
        type: "string",
        value: "n",
        description: `Parse at most n of the newest sessions for the parser check. Default: ${DOCTOR_DEFAULT_PARSE_LIMIT}.`,
      },
      JSON_OPTION,
      HELP_OPTION,
    ],
  },
  help: {
    name: "help",
    summary: "Show help for orbitrace or for one command.",
    usage: "orbitrace help [<command>] [--json]",
    arguments: [{ name: "command", optional: true, description: "The command to explain." }],
    options: [JSON_OPTION, HELP_OPTION],
  },
};

/**
 * The opt-in export options of `orbitrace export` (#122, #123), in the shape the `--json`
 * document reports them: `--opaque-names`, `--round-times <seconds>` (`null` without it) and
 * `--bucket-tokens`. Without any flag the export is the plain one, byte for byte.
 */
export interface ExportFlags {
  readonly names: ExportNames;
  readonly roundTimes: number | null;
  readonly bucketTokens: boolean;
}

/** Options shared by the commands that read sessions. */
export interface SourceFlags {
  readonly configDirs: readonly string[];
  readonly extraRoots: boolean;
}

export type ParsedCommand =
  | { readonly kind: "help"; readonly json: boolean; readonly command?: CommandName }
  | { readonly kind: "version"; readonly json: boolean }
  | {
      readonly kind: "list";
      readonly json: boolean;
      readonly sources: SourceFlags;
      readonly limit?: number;
    }
  | {
      readonly kind: "export";
      readonly json: boolean;
      readonly sources: SourceFlags;
      readonly key?: string;
      readonly latest: boolean;
      readonly output?: string;
      readonly force: boolean;
      readonly pretty: boolean;
      /** The opt-in export options (#122, #123) the flags asked for. */
      readonly exportOptions: ExportFlags;
    }
  | {
      readonly kind: "open";
      readonly json: boolean;
      readonly sources: SourceFlags;
      readonly key?: string;
      readonly latest: boolean;
      /** False with --no-browser. */
      readonly browser: boolean;
      readonly port?: number;
    }
  | {
      readonly kind: "doctor";
      readonly json: boolean;
      readonly sources: SourceFlags;
      /** Most sessions the parser check reads, newest first. */
      readonly parseLimit: number;
    };

/**
 * Whether `--json` appears before any `--`. Used to format an error raised while the rest of
 * the command line is being parsed.
 */
export function wantsJson(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--json") return true;
  }
  return false;
}

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

function toParseArgsOptions(specs: readonly OptionSpec[]): NonNullable<ParseArgsConfig["options"]> {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const spec of specs) {
    options[spec.name] = {
      type: spec.type,
      ...(spec.short === undefined ? {} : { short: spec.short }),
      ...(spec.multiple === true ? { multiple: true } : {}),
    };
  }
  return options;
}

/** The first sentence of a `parseArgs` error. It quotes only what the user typed. */
function parseArgsMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const first = message.split(/\.\s/)[0]?.trim() ?? "";
  if (first === "") return "The command line could not be understood.";
  return first.endsWith(".") ? first : `${first}.`;
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

function parseCommandArgs(
  command: CommandName,
  args: readonly string[],
): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: toParseArgsOptions(COMMANDS[command].options),
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (error) {
    throw usageError(parseArgsMessage(error), command);
  }
}

function stringList(value: Values[string]): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item): item is string => typeof item === "string");
}

function sourceFlags(values: Values, command: CommandName): SourceFlags {
  const configDirs = stringList(values["config-dir"]);
  if (configDirs.some((dir) => dir.trim() === "")) {
    throw usageError("--config-dir needs a folder path.", command);
  }
  return { configDirs, extraRoots: values["extra-roots"] === true };
}

/** A whole number of at least 1, or a usage error that names `flag`. */
export function parseLimit(value: string, command: CommandName = "list", flag = "--limit"): number {
  const message = `${flag} needs a whole number of at least 1.`;
  if (!/^\d+$/.test(value.trim())) throw usageError(message, command);
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit < 1) throw usageError(message, command);
  return limit;
}

const ROUND_TIMES_MESSAGE = `--round-times needs a number of seconds from ${ROUND_TIMES_MIN_STEP} to ${ROUND_TIMES_MAX_STEP}, in whole milliseconds, such as 0.1.`;

/**
 * A `--round-times` step: a plain decimal number of seconds that core's `isRoundTimesStep`
 * accepts (0.001 to 3600, whole milliseconds), or a usage error. The message does not repeat
 * the value.
 */
export function parseRoundTimes(value: string): number {
  const trimmed = value.trim();
  if (!/^\d{1,4}(\.\d{1,3})?$|^\.\d{1,3}$/.test(trimmed)) {
    throw usageError(ROUND_TIMES_MESSAGE, "export");
  }
  const step = Number(trimmed);
  if (!isRoundTimesStep(step)) throw usageError(ROUND_TIMES_MESSAGE, "export");
  return step;
}

/** The export options the parsed flags ask for. */
function exportFlags(values: Values): ExportFlags {
  return {
    names: values["opaque-names"] === true ? "opaque" : "as-written",
    roundTimes:
      typeof values["round-times"] === "string" ? parseRoundTimes(values["round-times"]) : null,
    bucketTokens: values["bucket-tokens"] === true,
  };
}

/** A port number from 1 to 65535, or a usage error. */
export function parsePort(value: string): number {
  const trimmed = value.trim();
  const port = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw usageError("--port needs a whole number from 1 to 65535.", "open");
  }
  return port;
}

/** The command a bare `orbitrace` runs: `open` with its defaults. */
export function defaultOpenCommand(json: boolean): ParsedCommand {
  return {
    kind: "open",
    json,
    sources: { configDirs: [], extraRoots: false },
    latest: false,
    browser: true,
  };
}

const GLOBAL_FLAGS = new Set(["--help", "-h", "--version", "-V", "--json"]);

/**
 * Parse the arguments after `orbitrace`. Throws a `usage` `CliError` for anything it cannot
 * understand. Global flags (`--help`, `--version`, `--json`) may come before the command; a
 * command's own options come after it. With no command, `orbitrace` runs `open` with its
 * defaults (newest session, default browser, free port).
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommand {
  let index = 0;
  const leading = new Set<string>();
  while (index < argv.length) {
    const arg = argv[index] as string;
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!GLOBAL_FLAGS.has(arg)) {
      throw usageError(`Unknown option '${arg}'. Put command options after the command.`);
    }
    leading.add(arg);
    index += 1;
  }
  const json = leading.has("--json");
  const help = leading.has("--help") || leading.has("-h");
  const name = argv[index];

  if (name === undefined) {
    if (help) return { kind: "help", json };
    if (leading.has("--version") || leading.has("-V")) return { kind: "version", json };
    return defaultOpenCommand(json);
  }
  if (!isCommandName(name)) {
    throw usageError(`Unknown command '${name}'. Commands: ${COMMAND_NAMES.join(", ")}.`);
  }
  if (leading.has("--version") || leading.has("-V")) {
    throw usageError("--version does not take a command.");
  }

  const { values, positionals } = parseCommandArgs(name, argv.slice(index + 1));
  const commandJson = json || values.json === true;
  if (help || values.help === true) return { kind: "help", json: commandJson, command: name };

  switch (name) {
    case "help": {
      if (positionals.length > 1) throw usageError("help takes at most one command.", "help");
      const target = positionals[0];
      if (target === undefined) return { kind: "help", json: commandJson };
      if (!isCommandName(target)) {
        throw usageError(
          `Unknown command '${target}'. Commands: ${COMMAND_NAMES.join(", ")}.`,
          "help",
        );
      }
      return { kind: "help", json: commandJson, command: target };
    }
    case "list": {
      if (positionals.length > 0) {
        throw usageError(`list takes no arguments, got '${positionals[0]}'.`, "list");
      }
      const limit = typeof values.limit === "string" ? parseLimit(values.limit) : undefined;
      return {
        kind: "list",
        json: commandJson,
        sources: sourceFlags(values, "list"),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    case "export": {
      if (positionals.length > 1) {
        throw usageError("export takes one session key.", "export");
      }
      const key = positionals[0];
      const latest = values.latest === true;
      if (key !== undefined && latest) {
        throw usageError("Give a session key or --latest, not both.", "export");
      }
      if (key === undefined && !latest) {
        throw usageError("Give a session key or --latest.", "export");
      }
      if (key !== undefined && key.trim() === "") {
        throw usageError("The session key is empty.", "export");
      }
      const output = typeof values.output === "string" ? values.output : undefined;
      if (output !== undefined && output.trim() === "") {
        throw usageError("-o needs a file path.", "export");
      }
      return {
        kind: "export",
        json: commandJson,
        sources: sourceFlags(values, "export"),
        ...(key === undefined ? {} : { key }),
        latest,
        ...(output === undefined ? {} : { output }),
        force: values.force === true,
        pretty: values.pretty === true,
        exportOptions: exportFlags(values),
      };
    }
    case "open": {
      if (positionals.length > 1) throw usageError("open takes one session key.", "open");
      const key = positionals[0];
      const latest = values.latest === true;
      if (key !== undefined && latest) {
        throw usageError("Give a session key or --latest, not both.", "open");
      }
      if (key !== undefined && key.trim() === "") {
        throw usageError("The session key is empty.", "open");
      }
      const port = typeof values.port === "string" ? parsePort(values.port) : undefined;
      return {
        kind: "open",
        json: commandJson,
        sources: sourceFlags(values, "open"),
        ...(key === undefined ? {} : { key }),
        latest,
        browser: values["no-browser"] !== true,
        ...(port === undefined ? {} : { port }),
      };
    }
    case "doctor": {
      if (positionals.length > 0) {
        throw usageError(`doctor takes no arguments, got '${positionals[0]}'.`, "doctor");
      }
      return {
        kind: "doctor",
        json: commandJson,
        sources: sourceFlags(values, "doctor"),
        parseLimit:
          typeof values["parse-limit"] === "string"
            ? parseLimit(values["parse-limit"], "doctor", "--parse-limit")
            : DOCTOR_DEFAULT_PARSE_LIMIT,
      };
    }
  }
}
