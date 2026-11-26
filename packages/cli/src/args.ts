/**
 * Command line parsing for `orbitrace`, on Node's `util.parseArgs`. The command specs below are
 * the single source for parsing, for the help text and for `orbitrace help --json`.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
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

export const COMMAND_NAMES = ["list", "export", "help"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

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
      "orbitrace export (<session-key> | --latest) [-o <file>] [--force] [--pretty] [--config-dir <path>]... [--extra-roots] [--json]",
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
      ...SOURCE_OPTIONS,
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

/** A whole number of at least 1, or a usage error. */
export function parseLimit(value: string, command: CommandName = "list"): number {
  if (!/^\d+$/.test(value.trim())) {
    throw usageError("--limit needs a whole number of at least 1.", command);
  }
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw usageError("--limit needs a whole number of at least 1.", command);
  }
  return limit;
}

const GLOBAL_FLAGS = new Set(["--help", "-h", "--version", "-V", "--json"]);

/**
 * Parse the arguments after `orbitrace`. Throws a `usage` `CliError` for anything it cannot
 * understand. Global flags (`--help`, `--version`, `--json`) may come before the command; a
 * command's own options come after it.
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
    return { kind: "help", json };
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
      };
    }
  }
}
