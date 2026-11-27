/**
 * `orbitrace history <status|enable|disable|ingest|list|delete|where>` (#195).
 *
 * - `status`, `enable`, `ingest`, `list` and `delete <key>` first check core's
 *   `historyCapability()`. Where the store cannot run (Node 20, where `node:sqlite` is missing)
 *   they explain why and exit with 13, `history-unavailable`. `disable`, `where` and
 *   `delete --all` need no `node:sqlite` (a settings file, a path, file deletions), so they run
 *   on every Node: turning recording off, finding the store and deleting it always work.
 * - Recording is off by default. Only `enable` and `disable` write the settings file, and
 *   `disable` only when it exists. Only `enable` and `ingest` create the data folder; only
 *   `ingest` creates the store. Every other subcommand reads, or deletes what is there.
 * - Output follows the other commands: with `--json`, one JSON document on stdout, errors as JSON
 *   on stderr; without it, results on stdout and notes, warnings and progress on stderr. Paths
 *   are shown with the home folder as `~`, as `doctor` shows them.
 */

import { createInterface } from "node:readline/promises";
import { listSessions, type SessionRef } from "@orbitrace/core";
import {
  deleteHistoryStore,
  formatHistoryBytes,
  openHistoryStore,
  runHistoryIngestWorker,
  withoutSqliteWarning,
  type HistoryCapability,
  type HistoryIngestResult,
  type HistoryLocation,
  type HistorySessionSummary,
  type HistoryStore,
  type HistoryTotals,
} from "@orbitrace/core/node";
import type { ParsedCommand } from "../args.js";
import { CliError, EXIT_OK, HISTORY_UNAVAILABLE_HINT, toCliError } from "../errors.js";
import { formatLocalTime, sanitizeForTerminal } from "../output.js";
import {
  CLI_ADAPTERS,
  matchSessionKeys,
  resolveRoots,
  type CliWarning,
  type HostContext,
} from "../sessions.js";
import {
  capabilityOf,
  historyLocationFor,
  isEndedSession,
  locationOptions,
  showLocalPath,
  storeBytes,
  storeExists,
  workerUrlOf,
  type HistoryRuntime,
} from "./context.js";
import { historySettingsFile, readHistorySettings, setHistoryRecording } from "./settings.js";

type HistoryCommand = Extract<ParsedCommand, { kind: "history" }>;

/** Where the command writes. The same shape as `CliIo` in cli.ts. */
export interface HistoryIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** How long `delete` waits for a running writer (an `open` that is recording), in milliseconds. */
export const DELETE_LOCK_WAIT_MS = 3000;

/** The data-folder facts every subcommand needs. */
interface HistoryPlace {
  readonly location: HistoryLocation;
  readonly settingsFile: string;
  readonly shown: {
    readonly dataDir: string;
    readonly database: string;
    readonly settings: string;
  };
}

function writeJson(io: HistoryIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

function writeWarnings(io: HistoryIo, warnings: readonly CliWarning[]): void {
  for (const warning of warnings) io.stderr(`orbitrace: warning: ${warning.message}\n`);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A byte count for people: B, KB, MB or GB, base 1000, one decimal from KB up (core's). */
export const formatBytes: (bytes: number) => string = formatHistoryBytes;

/** The capability as the JSON documents report it. */
function capabilityJson(capability: HistoryCapability): Record<string, unknown> {
  return capability.available
    ? {
        available: true,
        engine: capability.engine,
        nodeVersion: capability.nodeVersion,
        sqliteVersion: capability.sqliteVersion,
        fts5: capability.fts5,
      }
    : {
        available: false,
        engine: capability.engine,
        nodeVersion: capability.nodeVersion,
        reason: capability.reason,
      };
}

/** Open a reader, run `body`, close it. */
async function withReader<T>(host: HostContext, body: (store: HistoryStore) => T): Promise<T> {
  const store = await withoutSqliteWarning(() =>
    openHistoryStore({ ...locationOptions(host), mode: "read" }),
  );
  try {
    return body(store);
  } finally {
    store.close();
  }
}

function placeOf(host: HostContext): HistoryPlace {
  const location = historyLocationFor(host);
  const settingsFile = historySettingsFile(location, host.platform);
  return {
    location,
    settingsFile,
    shown: {
      dataDir: showLocalPath(location.dir, host),
      database: showLocalPath(location.dbFile, host),
      settings: showLocalPath(settingsFile, host),
    },
  };
}

/* ------------------------------------------------------------------ status, where */

async function runStatus(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  place: HistoryPlace,
  capability: HistoryCapability,
): Promise<number> {
  const settings = readHistorySettings(place.settingsFile);
  const exists = storeExists(place.location);
  let totals: HistoryTotals | null = null;
  let error: string | null = null;
  if (exists) {
    try {
      totals = await withReader(host, (store) => store.totals());
    } catch (caught) {
      error = toCliError(caught).message;
    }
  }
  const bytes = storeBytes(place.location);
  if (command.json) {
    writeJson(io, {
      recording: settings.recording,
      settings: settings.state,
      capability: capabilityJson(capability),
      dataDir: place.shown.dataDir,
      database: place.shown.database,
      store: {
        exists,
        sessions: totals?.sessions ?? null,
        files: totals?.files ?? null,
        lines: totals?.lines ?? null,
        bytes,
        error,
      },
    });
    return EXIT_OK;
  }
  const lines: string[] = [];
  if (settings.recording) {
    lines.push(
      "Recording: on. 'orbitrace open' copies sessions into the store in the background while it runs.",
    );
  } else if (settings.state === "invalid") {
    lines.push(
      "Recording: off. The settings file could not be read; 'orbitrace history enable' or 'disable' writes it again.",
    );
  } else {
    lines.push("Recording: off (the default). Turn it on with 'orbitrace history enable'.");
  }
  if (capability.available) {
    lines.push(
      `Engine: node:sqlite, SQLite ${capability.sqliteVersion}, Node ${capability.nodeVersion}.`,
    );
  }
  lines.push(`Store: ${place.shown.database}`);
  if (!exists) lines.push("Stored: nothing (there is no store yet).");
  else if (totals === null) lines.push(`Stored: unknown. ${error ?? ""}`.trimEnd());
  else {
    lines.push(
      `Stored: ${plural(totals.sessions, "session", "sessions")}, ${plural(totals.lines, "line", "lines")}, ${formatBytes(bytes)}.`,
    );
  }
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

function runWhere(command: HistoryCommand, io: HistoryIo, place: HistoryPlace): number {
  const exists = storeExists(place.location);
  if (command.json) {
    writeJson(io, {
      dataDir: place.shown.dataDir,
      database: place.shown.database,
      settings: place.shown.settings,
      exists,
    });
  } else {
    io.stdout(`${place.shown.dataDir}\n`);
    if (!exists) io.stderr("There is no history store in that folder yet.\n");
  }
  return EXIT_OK;
}

/* ------------------------------------------------------------------ enable, disable */

function runSwitch(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  place: HistoryPlace,
  on: boolean,
  canRead: boolean,
): number {
  // Core's shared switch (#211): with recording off and no settings file, disable writes
  // nothing, as it is off already.
  const { changed, written: write } = setHistoryRecording(place.location, on, {
    ...locationOptions(host),
    platform: host.platform,
  });
  const exists = storeExists(place.location);
  if (command.json) {
    writeJson(io, {
      recording: on,
      changed,
      settings: write ? place.shown.settings : null,
    });
    return EXIT_OK;
  }
  if (on) {
    io.stdout(
      `History recording is on${changed ? "" : " (it was already on)"}.\n` +
        `'orbitrace open' now copies your sessions into ${place.shown.database} in the background while it runs.\n` +
        "Run 'orbitrace history ingest' to copy them now.\n",
    );
    io.stderr(
      "The store keeps your prompts, replies and tool inputs and outputs, with known secret formats redacted. Turn it off with 'orbitrace history disable'.\n",
    );
  } else {
    io.stdout(
      `History recording is off${changed ? "" : " (it was already off)"}.\n` +
        (changed ? "A running 'orbitrace open' stops copying before its next copy.\n" : ""),
    );
    if (exists) {
      io.stdout(
        canRead
          ? "What is stored stays. Delete it with 'orbitrace history delete --all', or one session with 'orbitrace history delete <session-key>'.\n"
          : "What is stored stays. Delete it with 'orbitrace history delete --all'.\n",
      );
    }
  }
  return EXIT_OK;
}

/* ------------------------------------------------------------------ ingest */

/** The progress line on a terminal. */
function progressLine(done: number, total: number, lines: number): string {
  return `\rCopied ${done} of ${plural(total, "session", "sessions")}, ${plural(lines, "new line", "new lines")}.`;
}

async function runIngest(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  runtime: HistoryRuntime,
  place: HistoryPlace,
): Promise<number> {
  const workerUrl = workerUrlOf(runtime);
  if (workerUrl === null) {
    throw new CliError(
      "history-failed",
      "This build of orbitrace has no history worker.",
      "Build the repository with 'npm run build', then run the built command.",
    );
  }
  const { roots, warnings } = await resolveRoots(host, command.sources);
  if (!command.json) writeWarnings(io, warnings);
  const refs: readonly SessionRef[] = await listSessions(roots, CLI_ADAPTERS);
  const now = (runtime.now ?? Date.now)();
  const ended = refs.filter((ref) => isEndedSession(ref, now)).map((ref) => ref.key);
  const showProgress = !command.json && (runtime.terminal?.stderr ?? process.stderr.isTTY === true);
  let result: HistoryIngestResult;
  if (refs.length === 0) {
    result = {
      sessions: 0,
      sessionsSkipped: 0,
      files: 0,
      filesMissing: 0,
      filesReset: 0,
      linesRead: 0,
      linesAdded: 0,
      linesSkipped: 0,
      redactions: 0,
      durationMs: 0,
    };
  } else {
    let shown = false;
    try {
      result = await runHistoryIngestWorker(
        { sessions: refs, ...(ended.length === 0 ? {} : { endedSessionKeys: ended }) },
        {
          workerUrl,
          dataDir: place.location.dir,
          env: host.env,
          ...(showProgress
            ? {
                onProgress: (progress) => {
                  shown = true;
                  io.stderr(
                    progressLine(
                      progress.sessionsDone,
                      progress.sessionsTotal,
                      progress.linesAdded,
                    ),
                  );
                },
              }
            : {}),
        },
      );
    } finally {
      if (shown) io.stderr("\n");
    }
  }
  if (command.json) {
    writeJson(io, {
      ...result,
      database: refs.length === 0 ? null : place.shown.database,
      warnings,
    });
    return EXIT_OK;
  }
  if (refs.length === 0) {
    io.stdout("No sessions found to copy; nothing was written.\n");
    return EXIT_OK;
  }
  const extras = [
    `${plural(result.linesRead, "line", "lines")} read`,
    ...(result.redactions > 0
      ? [`${plural(result.redactions, "string", "strings")} redacted`]
      : []),
    ...(result.linesSkipped > 0
      ? [
          `${plural(result.linesSkipped, "line", "lines")} not stored (not JSON, and a secret pattern matched)`,
        ]
      : []),
    ...(result.filesMissing > 0
      ? [`${plural(result.filesMissing, "file", "files")} could not be read`]
      : []),
  ];
  io.stdout(
    `Copied ${plural(result.linesAdded, "new line", "new lines")} from ${plural(result.sessions, "session", "sessions")} into ${place.shown.database} (${extras.join(", ")}).\n`,
  );
  return EXIT_OK;
}

/* ------------------------------------------------------------------ list */

const HISTORY_LIST_HEADERS = [
  "KEY",
  "LAST ACTIVITY",
  "SUBAGENTS",
  "LINES",
  "TRANSCRIPT",
  "PROJECT",
] as const;

/** One row of `history list`: a stored session and whether its transcript is still found. */
export interface HistoryListEntry extends HistorySessionSummary {
  readonly transcript: "found" | "missing";
}

/** The stored sessions as an aligned table with a header row. */
export function formatHistoryTable(entries: readonly HistoryListEntry[]): string {
  const rows: string[][] = [
    [...HISTORY_LIST_HEADERS],
    ...entries.map((entry) => [
      entry.key,
      formatLocalTime(entry.lastActivity),
      String(entry.subagentCount),
      String(entry.lineCount),
      entry.transcript,
      sanitizeForTerminal(entry.projectLabel),
    ]),
  ];
  const widths = HISTORY_LIST_HEADERS.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] as string).length)),
  );
  const lines = rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column] as number),
      )
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

async function runList(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  place: HistoryPlace,
): Promise<number> {
  const { roots, warnings } = await resolveRoots(host, command.sources);
  let stored: readonly HistorySessionSummary[] = [];
  if (storeExists(place.location)) stored = await withReader(host, (store) => store.listSessions());
  const onDisk =
    stored.length === 0
      ? new Set<string>()
      : new Set((await listSessions(roots, CLI_ADAPTERS)).map((ref) => ref.key));
  const entries: HistoryListEntry[] = stored
    .slice(0, command.limit ?? stored.length)
    .map((session) => ({
      ...session,
      transcript: onDisk.has(session.key) ? "found" : "missing",
    }));
  if (command.json) {
    writeJson(io, { sessions: entries, warnings });
    return EXIT_OK;
  }
  writeWarnings(io, warnings);
  if (entries.length === 0) {
    const settings = readHistorySettings(place.settingsFile);
    io.stdout(
      "No sessions in the history store.\n" +
        (settings.recording
          ? "Recording is on: 'orbitrace open' copies sessions while it runs, or run 'orbitrace history ingest'.\n"
          : "Recording is off: turn it on with 'orbitrace history enable', or copy sessions once with 'orbitrace history ingest'.\n"),
    );
    return EXIT_OK;
  }
  io.stdout(formatHistoryTable(entries));
  return EXIT_OK;
}

/* ------------------------------------------------------------------ delete */

/** Ask on stderr and read one line from stdin. True for an answer starting with y. */
export async function promptYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question(question);
    return /^\s*y/i.test(answer);
  } finally {
    prompt.close();
  }
}

/**
 * Ask before deleting. `--yes` skips the question. Without a terminal, or with `--json`, nothing
 * is asked and nothing is deleted without `--yes`.
 */
async function confirm(
  command: HistoryCommand,
  runtime: HistoryRuntime,
  question: string,
): Promise<void> {
  if (command.yes) return;
  const terminal = runtime.terminal ?? {
    stdin: process.stdin.isTTY === true,
    stderr: process.stderr.isTTY === true,
  };
  if (command.json || !terminal.stdin || !terminal.stderr) {
    throw new CliError(
      "not-confirmed",
      "Nothing was deleted: deleting needs a confirmation.",
      "Add --yes to delete without being asked.",
    );
  }
  const ask = runtime.confirm ?? ((text: string) => promptYesNo(text));
  const yes = await ask(`${question} [y/N] `);
  if (!yes) throw new CliError("not-confirmed", "Nothing was deleted.");
}

async function runDeleteOne(
  command: HistoryCommand & { readonly key: string },
  io: HistoryIo,
  host: HostContext,
  runtime: HistoryRuntime,
  place: HistoryPlace,
): Promise<number> {
  const notFound = new CliError(
    "not-found",
    "No session with that key in the history store.",
    "Run 'orbitrace history list' to see the keys.",
  );
  if (!storeExists(place.location)) throw notFound;
  const stored = await withReader(host, (store) => store.listSessions());
  const matches = matchSessionKeys(
    stored.map((session) => session.key),
    command.key,
  );
  if (matches.length === 0) throw notFound;
  if (matches.length > 1) {
    throw new CliError(
      "ambiguous",
      `${matches.length} stored sessions have a key that starts with that value.`,
      "Give more characters of the key.",
    );
  }
  const key = matches[0] as string;
  const lines = stored.find((session) => session.key === key)?.lineCount ?? 0;
  await confirm(
    command,
    runtime,
    `Delete the stored copy of session ${key} (${plural(lines, "line", "lines")}) from the history store? Its transcript, if still there, is not touched.`,
  );
  const store = await withoutSqliteWarning(() =>
    openHistoryStore({ ...locationOptions(host), mode: "write", lockWaitMs: DELETE_LOCK_WAIT_MS }),
  );
  let scrubbed: boolean;
  try {
    scrubbed = store.deleteSession(key).scrubbed;
  } finally {
    store.close();
  }
  if (command.json) {
    writeJson(io, { key, deleted: true, lines, scrubbed });
    return EXIT_OK;
  }
  io.stdout(`Deleted session ${key} from the history store (${plural(lines, "line", "lines")}).\n`);
  if (!scrubbed) {
    io.stderr(
      "orbitrace: warning: another program had the store open, so old copies of the deleted lines stay in the store's WAL file until it closes it.\n",
    );
  }
  return EXIT_OK;
}

/**
 * `delete --all`. Works without `node:sqlite` (`canRead` false): the store's files are deleted
 * under the writer lock without opening it; only the session count is then unknown (`null`).
 */
async function runDeleteAll(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  runtime: HistoryRuntime,
  place: HistoryPlace,
  canRead: boolean,
): Promise<number> {
  const recording = readHistorySettings(place.settingsFile).recording;
  if (!storeExists(place.location)) {
    if (command.json) writeJson(io, { all: true, deleted: false, sessions: 0, recording });
    else io.stdout("There is no history store to delete.\n");
    return EXIT_OK;
  }
  let sessions: number | null = null;
  if (canRead) {
    try {
      sessions = await withReader(host, (store) => store.totals().sessions);
    } catch {
      // A store this version cannot read can still be deleted.
    }
  }
  const counted = sessions === null ? "" : ` (${plural(sessions, "session", "sessions")})`;
  await confirm(
    command,
    runtime,
    `Delete the whole history store${counted} in ${place.shown.dataDir}? Transcripts are not touched.`,
  );
  const deleted = await deleteHistoryStore({
    ...locationOptions(host),
    lockWaitMs: DELETE_LOCK_WAIT_MS,
  });
  if (command.json) {
    writeJson(io, { all: true, deleted, sessions, recording });
    return EXIT_OK;
  }
  io.stdout(`Deleted the history store${counted}.\n`);
  if (recording) {
    io.stdout(
      "Recording is still on, so 'orbitrace open' starts a new store. Turn it off with 'orbitrace history disable'.\n",
    );
  }
  return EXIT_OK;
}

/* ------------------------------------------------------------------ entry */

/** Run one history subcommand. Resolves with the exit code; failures throw a `CliError` or core's. */
export async function runHistoryCommand(
  command: HistoryCommand,
  io: HistoryIo,
  host: HostContext,
  runtime: HistoryRuntime = {},
): Promise<number> {
  const capability = await capabilityOf(runtime);
  // Turning recording off, finding the store and deleting it need no node:sqlite: they run on
  // every Node, so the opt-out and the delete are always reachable.
  if (command.action === "where") return runWhere(command, io, placeOf(host));
  if (command.action === "disable") {
    return runSwitch(command, io, host, placeOf(host), false, capability.available);
  }
  if (command.action === "delete" && command.key === undefined) {
    return runDeleteAll(command, io, host, runtime, placeOf(host), capability.available);
  }
  if (!capability.available) {
    throw new CliError("history-unavailable", capability.reason, HISTORY_UNAVAILABLE_HINT);
  }
  const place = placeOf(host);
  switch (command.action) {
    case "status":
      return runStatus(command, io, host, place, capability);
    case "enable":
      return runSwitch(command, io, host, place, true, true);
    case "ingest":
      return runIngest(command, io, host, runtime, place);
    case "list":
      return runList(command, io, host, place);
    case "delete":
      return command.key === undefined
        ? runDeleteAll(command, io, host, runtime, place, true)
        : runDeleteOne({ ...command, key: command.key }, io, host, runtime, place);
  }
}
