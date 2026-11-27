/** Help text and the `orbitrace help --json` document, both built from the command specs. */

import {
  COMMAND_NAMES,
  COMMANDS,
  GLOBAL_OPTIONS,
  type CommandName,
  type CommandSpec,
  type OptionSpec,
} from "./args.js";
import { CLI_EXIT_CODES } from "./errors.js";
import { CLI_NAME, cliVersion } from "./version.js";

function optionLabel(option: OptionSpec): string {
  const long = `--${option.name}${option.type === "string" ? ` <${option.value ?? "value"}>` : ""}`;
  return option.short === undefined ? `    ${long}` : `-${option.short}, ${long}`;
}

function table(rows: readonly (readonly [string, string])[], indent = "  "): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`);
}

/** Help for `orbitrace` itself. */
export function mainHelpText(): string {
  const lines = [
    `${CLI_NAME} ${cliVersion()}: replay Claude Code agent sessions as an orrery.`,
    "Orbitrace is not affiliated with Anthropic.",
    "",
    "Usage:",
    "  orbitrace [<command>] [options]",
    "",
    "Commands:",
    ...table(COMMAND_NAMES.map((name) => [name, COMMANDS[name].summary] as const)),
    "",
    "Options:",
    ...table(GLOBAL_OPTIONS.map((option) => [optionLabel(option), option.description] as const)),
    "",
    "With no command, orbitrace runs 'open': the newest session opens in your browser.",
    "Run 'orbitrace <command> --help' for the options of a command.",
    "Exit codes and error codes are listed in docs/cli.md.",
  ];
  return `${lines.join("\n")}\n`;
}

/** Help for one command. */
export function commandHelpText(name: CommandName): string {
  const spec = COMMANDS[name];
  const lines = [spec.summary, "", "Usage:", `  ${spec.usage}`];
  if (spec.arguments.length > 0) {
    lines.push(
      "",
      "Arguments:",
      ...table(spec.arguments.map((arg) => [`<${arg.name}>`, arg.description] as const)),
    );
  }
  lines.push(
    "",
    "Options:",
    ...table(spec.options.map((option) => [optionLabel(option), option.description] as const)),
  );
  if (name === "export") {
    lines.push(
      "",
      "Without -o the replay is written to stdout. An existing file is never replaced without --force.",
      "The replay holds structure only. Agent type and MCP server names are kept as they are:",
      "check them before you share the file.",
      "",
      "--opaque-names, --round-times and --bucket-tokens are off unless given; without them the",
      "file is the same as before they existed. --opaque-names hides the names you chose (agent",
      "types, MCP servers, tools that are not built in, model ids that are not known Claude ids),",
      "but not how many there are or which calls share one. --round-times hides exact times, not",
      "the order or rough length of anything. --bucket-tokens hides exact token counts, not their",
      "rough size. None of them hides the structure: agents, waves, calls, failures and replies.",
    );
  }
  if (name === "open") {
    lines.push(
      "",
      "The server listens on 127.0.0.1 only and runs until Ctrl+C. The link holds a token for",
      "this run: anyone with it can read your sessions while the server runs, so do not share it.",
      "Without --json the link is the only line on stdout.",
    );
  }
  if (name === "doctor") {
    lines.push(
      "",
      "Reads only: no file is written, no folder created, no database opened. Each check reports",
      "ok, warn, fail or skipped with a stable code, a one-line message and, for warn and fail, a",
      "fix to run. Exits with 0 when no check failed and with 12 (doctor-failed) when one did; the",
      "report goes to stdout either way. Folder paths show your home folder as ~. The codes and",
      "the --json shape are listed in docs/cli.md.",
    );
  }
  if (name === "list" || name === "export" || name === "open" || name === "doctor") {
    lines.push(
      "",
      "Folders are searched in this order: --config-dir, CLAUDE_CONFIG_DIR, the default",
      "config folder, then the desktop app's folders when --extra-roots is given.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function helpText(command?: CommandName): string {
  return command === undefined ? mainHelpText() : commandHelpText(command);
}

function commandJson(spec: CommandSpec): Record<string, unknown> {
  return {
    name: spec.name,
    summary: spec.summary,
    usage: spec.usage,
    arguments: spec.arguments.map((arg) => ({ ...arg })),
    options: spec.options.map((option) => ({
      name: `--${option.name}`,
      ...(option.short === undefined ? {} : { short: `-${option.short}` }),
      type: option.type,
      multiple: option.multiple === true,
      description: option.description,
    })),
  };
}

/** The document `orbitrace help --json` writes: every command, or the one asked for. */
export function helpJson(command?: CommandName): Record<string, unknown> {
  const names = command === undefined ? COMMAND_NAMES : [command];
  return {
    name: CLI_NAME,
    version: cliVersion(),
    commands: names.map((name) => commandJson(COMMANDS[name])),
    exitCodes: { ok: 0, ...CLI_EXIT_CODES },
  };
}
