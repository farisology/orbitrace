/**
 * The `orbitrace` command: parse the command line, run one command, return the exit code.
 *
 * Output rules:
 * - With `--json`, stdout gets exactly one JSON document (one line) on success and nothing on
 *   failure; a failure writes one JSON object `{ "error": { code, exitCode, message, hint? } }`
 *   to stderr.
 * - Without `--json`, results go to stdout and errors and warnings to stderr.
 * - No message shows an absolute path from the machine unless the user typed that path.
 *   `doctor` shows folder paths with the home folder as `~`.
 * - `doctor` is the one command that writes its document and still exits non-zero (12,
 *   `doctor-failed`) when one of its checks failed.
 */

import {
  exportReplay,
  listSessions,
  toSessionSummary,
  type ExportOptions,
  type ReplayModel,
} from "@orbitrace/core";
import { parseCommandLine, wantsJson, type ExportFlags, type ParsedCommand } from "./args.js";
import { runDoctorCommand, type DoctorRuntime } from "./doctor/run.js";
import { EXIT_OK, errorToJson, errorToText, toCliError } from "./errors.js";
import { helpJson, helpText } from "./help.js";
import { runHistoryCommand } from "./history/commands.js";
import type { HistoryRuntime } from "./history/context.js";
import { historySearch, isHistoryRef } from "./history/source.js";
import { runOpen, type OpenRuntime } from "./open.js";
import { formatSessionTable, writeOutputFile, type ListedSession } from "./output.js";
import { buildPulseDocument, formatPulseText } from "./pulse.js";
import {
  CLI_ADAPTERS,
  chooseSession,
  createReplayer,
  resolveRoots,
  type CliWarning,
  type HostContext,
} from "./sessions.js";
import { statusLine, versionJson } from "./version.js";

/** Where the command writes. */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * What `open`, `doctor`, `history` and `pulse` take from the process. `appDir` is shared: `doctor` checks
 * the same web app folder `open` serves. `history` (the store's capability check, the worker
 * file, the terminal) is shared by the history commands, `open`, `list`, `export` and `doctor`.
 */
export interface CliRuntime extends OpenRuntime {
  readonly doctor?: DoctorRuntime;
  /**
   * The clock, epoch milliseconds, for `pulse`'s relative `--since` / `--until` values (#27).
   * Default `Date.now`; tests fix it.
   */
  readonly now?: () => number;
}

/**
 * The doctor's runtime: its own fields, and `open`'s app folder and the history capability check
 * unless it names its own.
 */
export function doctorRuntime(runtime: CliRuntime): DoctorRuntime {
  const own = runtime.doctor ?? {};
  const appDir =
    own.appDir !== undefined || runtime.appDir === undefined ? {} : { appDir: runtime.appDir };
  const capability =
    own.historyCapability !== undefined || runtime.history?.capability === undefined
      ? {}
      : { historyCapability: runtime.history.capability };
  return { ...own, ...appDir, ...capability };
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function writeWarnings(io: CliIo, warnings: readonly CliWarning[]): void {
  for (const warning of warnings) io.stderr(`orbitrace: warning: ${warning.message}\n`);
}

const NO_SESSIONS_TEXT =
  "No sessions found.\n" +
  "Searched: --config-dir folders, CLAUDE_CONFIG_DIR and the default Claude Code config folder.\n" +
  "Pass --config-dir <path> to search another folder, or --extra-roots for the desktop app's folders.\n";

const SHARE_NOTE =
  "The replay holds structure only. Agent type and MCP server names are kept as they are: check them before you share it.\n";

/** The share note after `--opaque-names` (#122). */
const OPAQUE_SHARE_NOTE =
  "The replay holds structure only. Agent type, MCP server, custom tool and unknown model names were replaced by numbered labels; structure, counts, times and token counts are still in it.\n";

/** The `ExportOptions` of core for the export flags. Leaves out what is at its default. */
export function toExportOptions(flags: ExportFlags, pretty: boolean): ExportOptions {
  return {
    pretty,
    ...(flags.names === "opaque" ? { names: flags.names } : {}),
    ...(flags.roundTimes === null ? {} : { roundTimes: flags.roundTimes }),
    ...(flags.bucketTokens ? { bucketTokens: true } : {}),
  };
}

async function runList(
  command: Extract<ParsedCommand, { kind: "list" }>,
  io: CliIo,
  host: HostContext,
  history: HistoryRuntime,
): Promise<number> {
  const resolved = await resolveRoots(host, command.sources);
  const search = await historySearch(host, history, CLI_ADAPTERS);
  const roots = search.root === null ? resolved.roots : [...resolved.roots, search.root];
  const warnings = [...resolved.warnings, ...search.warnings];
  const refs = await listSessions(
    roots,
    search.adapters,
    command.limit === undefined ? undefined : { limit: command.limit },
  );
  // A session only the history store holds is marked; the others keep the plain summary.
  const sessions: ListedSession[] = refs.map((ref) =>
    isHistoryRef(ref) ? { ...toSessionSummary(ref), history: true } : toSessionSummary(ref),
  );
  if (command.json) {
    writeJson(io, { sessions, warnings });
    return EXIT_OK;
  }
  writeWarnings(io, warnings);
  io.stdout(sessions.length === 0 ? NO_SESSIONS_TEXT : formatSessionTable(sessions));
  return EXIT_OK;
}

async function runExport(
  command: Extract<ParsedCommand, { kind: "export" }>,
  io: CliIo,
  host: HostContext,
  history: HistoryRuntime,
): Promise<number> {
  const resolved = await resolveRoots(host, command.sources);
  // A session only the history store holds is exported from its stored lines, through the same
  // replayer, parser, builder and export allow-list (#195).
  const search = await historySearch(host, history, CLI_ADAPTERS);
  const roots = search.root === null ? resolved.roots : [...resolved.roots, search.root];
  const warnings = [...resolved.warnings, ...search.warnings];
  if (!command.json) writeWarnings(io, warnings);
  const replayer = createReplayer(roots, search.adapters);
  const key = await chooseSession(
    replayer,
    command.key === undefined ? { latest: true } : { key: command.key },
  );
  const model: ReplayModel = await replayer.load(key);
  const options = command.exportOptions;
  const result = exportReplay(model, toExportOptions(options, command.pretty));
  const toStdout = command.output === undefined || command.output === "-";

  if (toStdout) {
    if (command.json) {
      writeJson(io, {
        key,
        fileName: result.fileName,
        output: null,
        bytes: Buffer.byteLength(result.data, "utf8"),
        warnings,
        options,
        replay: JSON.parse(result.data) as unknown,
      });
    } else {
      io.stdout(result.data);
    }
    return EXIT_OK;
  }

  const written = writeOutputFile({
    target: command.output as string,
    cwd: host.cwd,
    fileName: result.fileName,
    data: result.data,
    force: command.force,
  });
  if (command.json) {
    writeJson(io, {
      key,
      fileName: result.fileName,
      output: written.shown,
      bytes: written.bytes,
      warnings,
      options,
    });
  } else {
    io.stdout(`Wrote ${written.shown} (${written.bytes} bytes).\n`);
    io.stderr(options.names === "opaque" ? OPAQUE_SHARE_NOTE : SHARE_NOTE);
  }
  return EXIT_OK;
}

async function runPulse(
  command: Extract<ParsedCommand, { kind: "pulse" }>,
  io: CliIo,
  host: HostContext,
  runtime: CliRuntime,
): Promise<number> {
  const now = (runtime.now ?? Date.now)();
  const { document, knownKeys } = await buildPulseDocument(
    command,
    host,
    runtime.history ?? {},
    now,
  );
  if (command.json) {
    writeJson(io, document);
    return EXIT_OK;
  }
  writeWarnings(io, document.warnings);
  io.stdout(formatPulseText(document, knownKeys));
  return EXIT_OK;
}

async function runCommand(
  command: ParsedCommand,
  io: CliIo,
  host: HostContext,
  runtime: CliRuntime,
): Promise<number> {
  switch (command.kind) {
    case "help":
      if (command.json) writeJson(io, helpJson(command.command));
      else io.stdout(helpText(command.command));
      return EXIT_OK;
    case "version":
      if (command.json) writeJson(io, versionJson());
      else io.stdout(`${statusLine()}\n`);
      return EXIT_OK;
    case "list":
      return runList(command, io, host, runtime.history ?? {});
    case "export":
      return runExport(command, io, host, runtime.history ?? {});
    case "pulse":
      return runPulse(command, io, host, runtime);
    case "open":
      return runOpen(command, io, host, runtime);
    case "history":
      return runHistoryCommand(command, io, host, runtime.history ?? {});
    case "doctor":
      return runDoctorCommand(command, io, host, doctorRuntime(runtime));
  }
}

/**
 * Run `orbitrace` with the arguments after the command name. Never throws: every failure is
 * written to stderr and turned into its exit code. `runtime` is for `open`, which keeps running
 * until its stop signal (see `OpenRuntime`), and for `doctor` (see `DoctorRuntime`).
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  host: HostContext,
  runtime: CliRuntime = {},
): Promise<number> {
  const json = wantsJson(argv);
  try {
    return await runCommand(parseCommandLine(argv), io, host, runtime);
  } catch (error) {
    const cliError = toCliError(error);
    if (json) io.stderr(`${JSON.stringify(errorToJson(cliError))}\n`);
    else io.stderr(errorToText(cliError));
    return cliError.exitCode;
  }
}
