/**
 * The checks of `orbitrace doctor` (#31). Every check reads only: nothing here writes a file,
 * creates a folder or opens a database file (the history check's capability probe opens an
 * in-memory database). Source resolution and listing are the same calls `list`
 * makes (`resolveRoots` in sessions.ts, core's `listSessions`); parsing is core's
 * `parseSession`.
 */

import { createServer } from "node:net";
import {
  describeResolution,
  parseSession,
  sourceRootKey,
  type LineCounts,
  type SessionRef,
  type SourceAdapter,
  type SourceResolution,
  type SourceRoot,
} from "@orbitrace/core";
import {
  CLAUDE_CODE_RUNTIME,
  CLAUDE_CONFIG_ENV,
  createNodeFileSystem,
  defaultConfigRoot,
  envValue,
  environmentConfigRoot,
  historyCapability,
  isProcessAlive,
  pathApiFor,
  pathApiForPath,
  readLiveRegistry,
  withoutSqliteWarning,
  type HistoryCapability,
} from "@orbitrace/core/node";
import { appBundleFolder, checkAppBundle } from "../app-bundle.js";
import { tryHistoryLocation } from "../history/context.js";
import {
  historySettingsFile,
  readHistorySettings,
  type HistorySettingsState,
} from "../history/settings.js";
import { APP_MISSING_HINT } from "../open.js";
import type { CliWarning, HostContext } from "../sessions.js";
import { satisfiesRange } from "./engines.js";
import {
  folderState,
  readAccessFix,
  rootPathShower,
  setEnvCommand,
  shellPath,
  showPath,
  unsetEnvCommand,
  type FolderState,
  type PathShower,
} from "./paths.js";
import type { DoctorCheckId, DoctorCheckResult, DoctorCode, DoctorStatus } from "./report.js";

/** A result without its id; `check` adds it. */
type Finding = Omit<DoctorCheckResult, "id">;

function finding(
  status: DoctorStatus,
  code: DoctorCode,
  message: string,
  fix: string | null,
  details: Record<string, unknown> = {},
): Finding {
  return { status, code, message, fix, details };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** At most `limit` items joined with commas, and how many more there are. */
function someOf(items: readonly string[], limit = 5): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/* ------------------------------------------------------------------ node-version */

/** Node's version and the `engines.node` range it is checked against. */
export function checkNodeVersion(version: string, range: string | null): Finding {
  if (range === null) {
    return finding(
      "skipped",
      "node-version-range-unknown",
      `Node ${version} is running; this build of orbitrace names no supported range to check it against.`,
      null,
      { version, range, satisfies: null },
    );
  }
  const satisfies = satisfiesRange(version, range);
  if (satisfies === null) {
    return finding(
      "skipped",
      "node-version-range-unknown",
      `Node ${version} is running; the supported range '${range}' could not be read.`,
      null,
      { version, range, satisfies },
    );
  }
  if (!satisfies) {
    return finding(
      "fail",
      "node-version-unsupported",
      `Node ${version} is outside the supported range '${range}'.`,
      "Install a supported Node version, for example the current LTS with 'nvm install --lts && nvm use --lts', then run 'orbitrace doctor' again.",
      { version, range, satisfies },
    );
  }
  return finding(
    "ok",
    "node-version-ok",
    `Node ${version} is in the supported range '${range}'.`,
    null,
    { version, range, satisfies },
  );
}

/* ------------------------------------------------------------------ config-folder */

/** The fix that points `CLAUDE_CONFIG_DIR` somewhere else, for this platform. */
function pointEnvFix(platform: string): string {
  return `set CLAUDE_CONFIG_DIR to the folder that holds projects/ ('${setEnvCommand(CLAUDE_CONFIG_ENV, "<absolute path>", platform)}')`;
}

/**
 * Which folder Claude Code writes its sessions to and why: `CLAUDE_CONFIG_DIR` when it is set,
 * else the default folder under the home folder. Then whether it exists, can be read and has a
 * `projects/` folder. `roots` are the folders `list` searches: when another one of them can be
 * read (for example one given with `--config-dir`), a missing config folder only warns.
 */
export async function checkConfigFolder(
  host: HostContext,
  roots: readonly SourceRoot[],
): Promise<Finding> {
  const { platform, homeDir, env } = host;
  const raw = envValue(env, CLAUDE_CONFIG_ENV, platform);
  const envSet = raw !== undefined && raw.trim() !== "";
  const envRoot = environmentConfigRoot(platform, homeDir, env);
  const homeVar = platform === "win32" ? "USERPROFILE" : "HOME";
  const base = { env: envSet ? (envRoot === null ? "invalid" : "set") : "unset" };

  if (envSet && envRoot === null) {
    return finding(
      "fail",
      "config-folder-env-invalid",
      "CLAUDE_CONFIG_DIR is set but is not an absolute path, so Orbitrace ignores it.",
      `Set it to the absolute path of the folder that holds projects/ ('${setEnvCommand(CLAUDE_CONFIG_ENV, "<absolute path>", platform)}'), or remove it ('${unsetEnvCommand(CLAUDE_CONFIG_ENV, platform)}').`,
      { ...base, path: null, resolvedBy: null, reason: null, state: null, projects: null },
    );
  }
  const path = envRoot ?? defaultConfigRoot(platform, homeDir, env);
  if (path === null) {
    return finding(
      "fail",
      "config-folder-no-home",
      `No home folder is known (${homeVar} is not set), so the default config folder cannot be found.`,
      `Set ${homeVar} to your home folder ('${setEnvCommand(homeVar, "<your home folder>", platform)}'), or ${pointEnvFix(platform)}, or pass --config-dir <path>.`,
      { ...base, path: null, resolvedBy: null, reason: null, state: null, projects: null },
    );
  }

  const resolvedBy: SourceResolution = envRoot !== null ? "environment" : "os-default";
  const reason = describeResolution({ runtime: CLAUDE_CODE_RUNTIME, resolvedBy, available: true });
  const shown = showPath(path, homeDir, platform);
  const state = await folderState(path);
  const projectsPath = pathApiFor(platform).join(path, "projects");
  const projects: FolderState | null = state === "ok" ? await folderState(projectsPath) : null;
  const details = { ...base, path: shown, resolvedBy, reason, state, projects };
  const fromEnv = resolvedBy === "environment";
  const ownKey = sourceRootKey({ runtime: CLAUDE_CODE_RUNTIME, root: path });
  const otherFolderReadable = roots.some(
    (root) => root.available && sourceRootKey(root) !== ownKey,
  );

  switch (state) {
    case "missing":
      return finding(
        otherFolderReadable ? "warn" : "fail",
        "config-folder-missing",
        `The config folder ${shown} does not exist. ${reason}`,
        fromEnv
          ? `Run Claude Code once with this setting ('claude') so it creates the folder, or ${pointEnvFix(platform)}, or remove it ('${unsetEnvCommand(CLAUDE_CONFIG_ENV, platform)}').`
          : `Run Claude Code once ('claude') so it creates ${shown}, or ${pointEnvFix(platform)}, or pass --config-dir <path>.`,
        details,
      );
    case "not-a-folder":
      return finding(
        "fail",
        "config-folder-not-a-folder",
        `The config folder ${shown} is a file, not a folder. ${reason}`,
        fromEnv
          ? `${pointEnvFix(platform).replace(/^set/, "Set")}.`
          : `Move the file away ('${platform === "win32" ? "move" : "mv"} ${shellPath(shown, platform)} ${shellPath(`${shown}.bak`, platform)}'), then run Claude Code once ('claude').`,
        details,
      );
    case "unreadable":
      return finding(
        "fail",
        "config-folder-unreadable",
        `The config folder ${shown} cannot be read by your account. ${reason}`,
        `Give your account read access: '${readAccessFix(shown, platform)}'.`,
        details,
      );
    case "ok":
      break;
  }
  if (projects === "not-a-folder") {
    const shownProjects = showPath(projectsPath, homeDir, platform);
    return finding(
      "fail",
      "config-folder-projects-not-a-folder",
      `The projects path ${shownProjects} is a file, not a folder, so no sessions can be listed.`,
      `Move the file away ('${platform === "win32" ? "move" : "mv"} ${shellPath(shownProjects, platform)} ${shellPath(`${shownProjects}.bak`, platform)}'), then run Claude Code once ('claude') so it creates the folder.`,
      details,
    );
  }
  if (projects === "unreadable") {
    const shownProjects = showPath(projectsPath, homeDir, platform);
    return finding(
      "fail",
      "config-folder-unreadable",
      `The projects folder ${shownProjects} cannot be read by your account.`,
      `Give your account read access: '${readAccessFix(shownProjects, platform)}'.`,
      details,
    );
  }
  if (projects === "missing") {
    return finding(
      "warn",
      "config-folder-no-projects",
      `The config folder ${shown} has no projects/ folder, so it holds no sessions yet.`,
      "Start a Claude Code session ('claude') to create it, or pass --config-dir <path> if your sessions are in another folder.",
      details,
    );
  }
  return finding(
    "ok",
    "config-folder-ok",
    `Claude Code's config folder is ${shown}. ${reason}`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ session-roots */

/** Sessions per root, keyed by `sourceRootKey`. */
function countByRoot(sessions: readonly SessionRef[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of sessions) {
    const key = sourceRootKey(ref.source);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const ROOTS_FIX =
  "Pass --config-dir <folder that holds projects/>, or set CLAUDE_CONFIG_DIR to that folder, or run Claude Code once ('claude') to create the default folder.";

/**
 * The folders `list` searches (the same resolution), how each was found, whether it can be
 * read, and how many sessions it holds. `warnings` are `resolveRoots`'s warnings for
 * `--config-dir` folders; their messages show the path as typed. `show` is the report's path
 * display (`rootPathShower` with the typed `--config-dir` values).
 */
export function checkSessionRoots(
  host: HostContext,
  roots: readonly SourceRoot[],
  warnings: readonly CliWarning[],
  sessions: readonly SessionRef[],
  show: PathShower = rootPathShower(host, roots, []),
): Finding {
  const counts = countByRoot(sessions);
  const listed = roots.map((root) => ({
    path: show(root.root),
    resolvedBy: root.resolvedBy,
    reason: describeResolution(root),
    available: root.available,
    sessions: counts.get(sourceRootKey(root)) ?? 0,
  }));
  const readable = listed.filter((root) => root.available).length;
  const details = {
    roots: listed,
    sessions: sessions.length,
    warnings: warnings.map((warning) => ({ ...warning })),
  };
  if (roots.length === 0) {
    return finding(
      "fail",
      "session-roots-none",
      "No session folder could be worked out: no --config-dir, no CLAUDE_CONFIG_DIR and no home folder.",
      ROOTS_FIX,
      details,
    );
  }
  if (readable === 0) {
    return finding(
      "fail",
      "session-roots-unavailable",
      `None of the ${plural(roots.length, "session folder", "session folders")} exists or can be read.`,
      ROOTS_FIX,
      details,
    );
  }
  if (warnings.length > 0) {
    return finding(
      "warn",
      "session-roots-config-dir-unavailable",
      `${plural(warnings.length, "folder", "folders")} given with --config-dir ${warnings.length === 1 ? "was" : "were"} not found or cannot be read.`,
      "Pass the folder that holds projects/ (for example '--config-dir ~/.claude') and check its spelling; see 'orbitrace list --help'.",
      details,
    );
  }
  if (sessions.length === 0) {
    return finding(
      "warn",
      "session-roots-empty",
      `No sessions found in ${plural(readable, "readable folder", "readable folders")}.`,
      "Start a Claude Code session ('claude'), then run 'orbitrace doctor' again; if your sessions are in another folder pass --config-dir <path>, and for desktop app sessions add --extra-roots.",
      details,
    );
  }
  return finding(
    "ok",
    "session-roots-ok",
    `Found ${plural(sessions.length, "session", "sessions")} in ${readable} of ${plural(roots.length, "folder", "folders")}.`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ parser */

/** Most line type names listed in the report; the rest are counted. */
export const UNKNOWN_TYPES_LISTED = 20;
/** Longest line type name shown; a longer one is cut. */
const TYPE_NAME_MAX = 64;
/** Most runtime versions listed in the report. */
const VERSIONS_LISTED = 20;

/** A line type as the report shows it: control characters as `?`, at most 64 characters. */
export function reportTypeName(type: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = type.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  if (clean === "") return "(none)";
  return clean.length > TYPE_NAME_MAX ? `${clean.slice(0, TYPE_NAME_MAX - 3)}...` : clean;
}

const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+.][0-9A-Za-z.-]{1,24})?$/;

function compareVersions(a: string, b: string): number {
  const parts = (value: string): number[] =>
    value
      .split(/[-+]/)[0]!
      .split(".")
      .map((part) => Number(part));
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (x[index] ?? 0) - (y[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What parsing the newest sessions found. */
export interface ParserTally {
  readonly sessions: number;
  readonly unreadable: number;
  /** Root of the first session that could not be read, for the fix. */
  readonly unreadableRoot: string | null;
  readonly lines: number;
  readonly malformed: number;
  readonly malformedSessions: number;
  readonly unknownByType: Readonly<Record<string, number>>;
  readonly versions: readonly string[];
}

/** Parse each session with core's parser and add up the line counts. */
export async function tallySessions(
  refs: readonly SessionRef[],
  adapters: readonly SourceAdapter[],
): Promise<ParserTally> {
  let unreadable = 0;
  let unreadableRoot: string | null = null;
  let lines = 0;
  let malformed = 0;
  let malformedSessions = 0;
  const unknown = new Map<string, number>();
  const versions = new Set<string>();
  for (const ref of refs) {
    const adapter = adapters.find((candidate) => candidate.runtime === ref.runtime);
    let counts: LineCounts;
    let seen: readonly string[];
    try {
      if (adapter === undefined) throw new Error("no adapter");
      const parsed = await parseSession(await adapter.openSession(ref));
      counts = parsed.lines;
      seen = parsed.versionsSeen;
    } catch {
      unreadable += 1;
      unreadableRoot ??= ref.source.root;
      continue;
    }
    lines += counts.total;
    malformed += counts.malformed;
    if (counts.malformed > 0) malformedSessions += 1;
    for (const [type, count] of Object.entries(counts.unknownByType)) {
      unknown.set(type, (unknown.get(type) ?? 0) + count);
    }
    for (const version of seen) if (VERSION_PATTERN.test(version)) versions.add(version);
  }
  return {
    sessions: refs.length - unreadable,
    unreadable,
    unreadableRoot,
    lines,
    malformed,
    malformedSessions,
    unknownByType: Object.fromEntries(unknown),
    versions: [...versions].sort(compareVersions),
  };
}

/**
 * Parser health over the newest `limit` sessions: lines that were not valid JSON, lines of a
 * type the parser does not know (by type name and count only), sessions that could not be read,
 * and the Claude Code versions the lines name. No line content is kept or shown. `show` is the
 * report's path display (`rootPathShower` with the typed `--config-dir` values).
 */
export async function checkParser(
  host: HostContext,
  sessions: readonly SessionRef[],
  limit: number,
  adapters: readonly SourceAdapter[],
  show: PathShower = (path) => showPath(path, host.homeDir, host.platform),
): Promise<Finding> {
  const refs = sessions.slice(0, limit);
  // With no sessions every count is 0, so the details keep the same keys.
  const tally = await tallySessions(refs, adapters);
  const types = Object.entries(tally.unknownByType)
    .map(([type, count]) => [reportTypeName(type), count] as const)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  const unknownByType: Record<string, number> = {};
  for (const [type, count] of types.slice(0, UNKNOWN_TYPES_LISTED)) {
    unknownByType[type] = (unknownByType[type] ?? 0) + count;
  }
  const unknownLines = types.reduce((sum, [, count]) => sum + count, 0);
  const versions = tally.versions;
  const details = {
    limit,
    checked: refs.length,
    parsed: tally.sessions,
    unreadable: tally.unreadable,
    lines: tally.lines,
    malformed: tally.malformed,
    malformedSessions: tally.malformedSessions,
    unknownLines,
    unknownByType,
    unknownTypesNotListed: Math.max(0, types.length - UNKNOWN_TYPES_LISTED),
    versions: versions.slice(-VERSIONS_LISTED),
  };
  if (refs.length === 0) {
    return finding("skipped", "parser-no-sessions", "No sessions to parse.", null, details);
  }
  const scope = `the newest ${plural(refs.length, "session", "sessions")} (limit ${limit}, change it with --parse-limit <n>)`;
  const range =
    versions.length === 0
      ? ""
      : versions.length === 1
        ? `, Claude Code ${versions[0]}`
        : `, Claude Code ${versions[0]} to ${versions[versions.length - 1]}`;
  const skipped =
    unknownLines === 0
      ? ""
      : `; skipped ${plural(unknownLines, "line", "lines")} of ${plural(types.length, "type", "types")} the parser does not use: ${someOf(types.map(([type, count]) => `${type} (${count})`))}`;

  if (tally.unreadable > 0) {
    const root = tally.unreadableRoot === null ? "~/.claude" : show(tally.unreadableRoot);
    return finding(
      "warn",
      "parser-unreadable",
      `${tally.unreadable} of ${scope} could not be read.`,
      `Give your account read access to the session folder: '${readAccessFix(root, host.platform)}'.`,
      details,
    );
  }
  if (tally.malformed > 0) {
    return finding(
      "warn",
      "parser-malformed-lines",
      `${plural(tally.malformed, "line", "lines")} in ${plural(tally.malformedSessions, "session", "sessions")} of ${scope} were not valid JSON and were skipped${skipped}.`,
      "If a session was running, its last line may be half-written: run 'orbitrace doctor' again when it stops. Otherwise update Claude Code ('claude update'); the rest of each session still replays.",
      details,
    );
  }
  return finding(
    "ok",
    "parser-ok",
    `Parsed ${scope}: ${plural(tally.lines, "line", "lines")}${range}, no malformed lines${skipped}.`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ running-registry */

/**
 * The running-sessions folder of each readable config folder: present, readable, entries. `show`
 * is the report's path display (`rootPathShower` with the typed `--config-dir` values).
 */
export async function checkRunningRegistry(
  host: HostContext,
  roots: readonly SourceRoot[],
  show: PathShower = rootPathShower(host, roots, []),
): Promise<Finding> {
  const readable = roots.filter((root) => root.available);
  if (readable.length === 0) {
    return finding(
      "skipped",
      "running-registry-no-roots",
      "No readable config folder, so there is no running-sessions folder to read.",
      null,
      { folders: [] },
    );
  }
  const fs = createNodeFileSystem();
  const folders: {
    path: string;
    state: FolderState;
    entries: number | null;
    running: number | null;
  }[] = [];
  for (const root of readable) {
    const p = pathApiForPath(root.root);
    const dir = p.join(root.root, "sessions");
    const state = await folderState(dir);
    let entries: number | null = null;
    let running: number | null = null;
    if (state === "ok") {
      const registry = await readLiveRegistry(fs, p, dir, isProcessAlive);
      entries = registry.bySessionId.size;
      running = [...registry.bySessionId.values()].filter((record) => record.alive).length;
    }
    folders.push({ path: show(dir), state, entries, running });
  }
  const details = { folders };
  const broken = folders.find(
    (folder) => folder.state === "unreadable" || folder.state === "not-a-folder",
  );
  if (broken?.state === "unreadable") {
    return finding(
      "fail",
      "running-registry-unreadable",
      `The running-sessions folder ${broken.path} cannot be read, so live status shows as 'unknown'.`,
      `Give your account read access: '${readAccessFix(broken.path, host.platform)}'.`,
      details,
    );
  }
  if (broken?.state === "not-a-folder") {
    return finding(
      "fail",
      "running-registry-not-a-folder",
      `${broken.path} is a file, not a folder, so live status cannot be read.`,
      `Move the file away ('${host.platform === "win32" ? "move" : "mv"} ${shellPath(broken.path, host.platform)} ${shellPath(`${broken.path}.bak`, host.platform)}'); Claude Code writes the folder again when a session starts.`,
      details,
    );
  }
  const present = folders.filter((folder) => folder.state === "ok");
  if (present.length === 0) {
    // Lead decision on #184: informational, not a warning. Desktop-only and older set-ups never
    // have this folder; live status then shows as 'unknown' and everything else works.
    return finding(
      "ok",
      "running-registry-missing",
      `No config folder has a running-sessions folder (sessions/), so live status shows as 'unknown'. Claude Code writes ${folders[0]!.path} while a session runs; desktop-only and older set-ups have none.`,
      null,
      details,
    );
  }
  const entries = present.reduce((sum, folder) => sum + (folder.entries ?? 0), 0);
  const running = present.reduce((sum, folder) => sum + (folder.running ?? 0), 0);
  return finding(
    "ok",
    "running-registry-ok",
    `Read the running-sessions folder of ${present.length} of ${plural(folders.length, "config folder", "config folders")}: ${plural(entries, "session", "sessions")} listed, ${running} running.`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ app-bundle */

/**
 * The web app `orbitrace open` serves: `index.html` and every file it loads. `dir` is the app
 * folder; `null` means this build has none. The folder's path is not shown.
 */
export function checkAppBundleFinding(dir: string | null = appBundleFolder()): Finding {
  const state =
    dir === null
      ? { present: false, references: [] as string[], missing: [] as string[] }
      : checkAppBundle(dir);
  const details = {
    present: state.present,
    files: state.references.length,
    missing: [...state.missing],
  };
  if (!state.present) {
    return finding(
      "fail",
      "app-bundle-missing",
      "This build of orbitrace has no web app, so 'orbitrace open' fails with app-missing.",
      APP_MISSING_HINT,
      details,
    );
  }
  if (state.missing.length > 0) {
    return finding(
      "fail",
      "app-bundle-incomplete",
      `The web app is missing ${state.missing.length} of the ${plural(state.references.length, "file", "files")} its page loads: ${someOf(state.missing)}.`,
      APP_MISSING_HINT,
      details,
    );
  }
  return finding(
    "ok",
    "app-bundle-ok",
    `The web app that 'orbitrace open' serves has its page and all ${plural(state.references.length, "file", "files")} the page loads.`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ loopback-port */

/** The address `orbitrace open` listens on. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Listen on a free port of 127.0.0.1 and close it at once. Rejects when listening fails. */
export function bindLoopbackPort(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.close(() => resolve());
    });
  });
}

/** A Node error code such as `EACCES`, or null. Never the error's message, which may name a path. */
function nodeErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

/** Whether a port of 127.0.0.1 can be listened on, as `orbitrace open` needs. */
export async function checkLoopbackPort(
  bind: () => Promise<void> = bindLoopbackPort,
): Promise<Finding> {
  try {
    await bind();
  } catch (error) {
    const errorCode = nodeErrorCode(error);
    return finding(
      "fail",
      "loopback-port-unavailable",
      `Could not listen on a free port of ${LOOPBACK_HOST}${errorCode === null ? "" : ` (${errorCode})`}, so 'orbitrace open' cannot start its server.`,
      "Allow Node to listen on 127.0.0.1: check the firewall (on macOS: System Settings > Network > Firewall) and any sandbox or container network setting, then run 'orbitrace doctor' again.",
      { host: LOOPBACK_HOST, bound: false, errorCode },
    );
  }
  return finding(
    "ok",
    "loopback-port-ok",
    `Listened on a free port of ${LOOPBACK_HOST} and closed it again.`,
    null,
    { host: LOOPBACK_HOST, bound: true, errorCode: null },
  );
}

/* ------------------------------------------------------------------ history-store */

/** The module the history store needs. */
export const HISTORY_MODULE = "node:sqlite";

/** The first Node versions that load `node:sqlite` without a flag. */
export const HISTORY_NODE_VERSIONS = "22.13 or later";

/** Whether the user turned history recording on, as the settings file says (#195). */
export interface HistoryRecordingState {
  /** `missing` (off, the default), `ok`, `invalid` (off), or `unknown` (no data folder). */
  readonly settings: HistorySettingsState | "unknown";
  readonly recording: boolean;
}

/**
 * The recording switch of this host: the settings file in the data folder, read without
 * creating anything. `unknown` when no data folder can be worked out.
 */
export function readRecordingState(host: HostContext): HistoryRecordingState {
  const location = tryHistoryLocation(host);
  if (location === null) return { settings: "unknown", recording: false };
  const { state, recording } = readHistorySettings(historySettingsFile(location, host.platform));
  return { settings: state, recording };
}

/**
 * Whether this Node can run the history store, from core's `historyCapability()` (#184), and
 * whether recording is on (#195). Core loads `node:sqlite` and opens an in-memory database to
 * read its version; no database file is opened or created. With recording off, a Node without
 * `node:sqlite` is `skipped`: nothing needs it. With recording on, it is a warning.
 */
export async function checkHistoryStore(
  nodeVersion: string,
  capability: () => Promise<HistoryCapability> = () => withoutSqliteWarning(historyCapability),
  state: HistoryRecordingState = { settings: "missing", recording: false },
): Promise<Finding> {
  const found = await capability();
  const details = {
    module: HISTORY_MODULE,
    available: found.available,
    inUse: state.recording,
    errorCode: null,
    recording: state.recording,
    settings: state.settings,
    reason: found.available ? null : found.reason,
    sqliteVersion: found.available ? found.sqliteVersion : null,
    fts5: found.available ? found.fts5 : null,
  };
  if (state.settings === "invalid") {
    return finding(
      "warn",
      "history-store-settings-invalid",
      "The history settings file could not be read, so history recording is off.",
      // `history enable` needs node:sqlite; `history disable` runs on every Node.
      found.available
        ? "Write it again with 'orbitrace history enable' (recording on) or 'orbitrace history disable' (off)."
        : `Write it again with 'orbitrace history disable' (off). Turning recording on needs Node ${HISTORY_NODE_VERSIONS}.`,
      details,
    );
  }
  if (!found.available && !state.recording) {
    return finding(
      "skipped",
      "history-store-not-in-use",
      `History recording is off, so nothing needs it. ${HISTORY_MODULE} cannot be loaded in Node ${nodeVersion}; history needs Node ${HISTORY_NODE_VERSIONS}.`,
      null,
      details,
    );
  }
  if (!found.available) {
    return finding(
      "warn",
      "history-store-unavailable",
      `History recording is on, but ${HISTORY_MODULE} cannot be loaded in Node ${nodeVersion}, so nothing is recorded; it needs Node ${HISTORY_NODE_VERSIONS}.`,
      // `history disable` needs no node:sqlite, so it works on this Node.
      "Install Node 22.13 or later (for example 'nvm install 22 && nvm use 22'), then run 'orbitrace doctor' again; or turn recording off with 'orbitrace history disable'.",
      details,
    );
  }
  return finding(
    "ok",
    "history-store-available",
    `${HISTORY_MODULE} loads in Node ${nodeVersion} (SQLite ${found.sqliteVersion}), so the history store can run here. ${state.recording ? "History recording is on." : "History recording is off; turn it on with 'orbitrace history enable'."}`,
    null,
    details,
  );
}

/* ------------------------------------------------------------------ hooks, remote-sources */

/** Hooks: nothing to check until a hooks adapter exists (#30). */
export function checkHooks(): Finding {
  return finding(
    "skipped",
    "hooks-not-built",
    "Orbitrace has no hooks adapter yet (#30), so there are no hooks to check.",
    null,
  );
}

/** Remote set-ups: nothing to check until remote sources exist (#30). */
export function checkRemoteSources(): Finding {
  return finding(
    "skipped",
    "remote-sources-not-built",
    "Orbitrace reads local folders only; remote sources are not built yet (#30).",
    null,
  );
}

/* ------------------------------------------------------------------ running a check */

/** Fixed text for a check that threw; the error's own text may name a path and is not shown. */
export const CHECK_ERROR_MESSAGE = "This check could not run.";

/** Run one check. A check that throws becomes a `fail` with the `check-error` code. */
export async function check(
  id: DoctorCheckId,
  run: () => Finding | Promise<Finding>,
): Promise<DoctorCheckResult> {
  try {
    return { id, ...(await run()) };
  } catch {
    return {
      id,
      status: "fail",
      code: "check-error",
      message: CHECK_ERROR_MESSAGE,
      fix: "Run 'orbitrace doctor' again; if it keeps failing, open an issue at https://github.com/farisology/orbitrace/issues with this report.",
      details: {},
    };
  }
}
