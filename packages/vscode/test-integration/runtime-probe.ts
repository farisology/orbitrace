/**
 * What runtime a downloaded editor bundles (ticket #196): its Node, Electron and SQLite versions,
 * and whether `node:sqlite` (the engine of the history store) loads in it and has FTS5.
 *
 * Measured the way docs/decisions/0001-storage.md did: the editor binary is started as plain
 * Node with `ELECTRON_RUN_AS_NODE=1`, runs `RUNTIME_PROBE_SCRIPT` with `-e`, and prints one line
 * that starts with `RUNTIME_PROBE_MARKER`. Nothing is written to disk.
 *
 * The launcher (`run.ts`) prints the result before every integration run, and with
 * `ORBITRACE_IT_PROBE_ONLY=1` prints it and stops, without starting the editor.
 *
 * No vscode dependency, so it is unit tested (`runtime-probe.test.ts`).
 */

import { spawnSync } from "node:child_process";

/** Start of the one output line the probe script prints. */
export const RUNTIME_PROBE_MARKER = "ORBITRACE_RUNTIME ";

/**
 * The probe, as CommonJS source for `-e`. Loads `node:sqlite` with `require`, as the decision
 * record did, opens an in-memory database and tries to create an FTS5 table. Prints only
 * version numbers, booleans and an error code: never a path.
 */
export const RUNTIME_PROBE_SCRIPT = [
  "const v = process.versions;",
  "const r = { node: v.node, electron: v.electron ?? null, sqlite: v.sqlite ?? null,",
  "  modules: v.modules ?? null, nodeSqlite: false, sqliteVersion: null, fts5: null, error: null };",
  "try {",
  '  const s = require("node:sqlite");',
  "  r.nodeSqlite = true;",
  '  const db = new s.DatabaseSync(":memory:");',
  "  try {",
  '    r.sqliteVersion = db.prepare("SELECT sqlite_version() AS v").get().v;',
  '    try { db.exec("CREATE VIRTUAL TABLE p USING fts5(x)"); r.fts5 = true; }',
  "    catch { r.fts5 = false; }",
  "  } finally { db.close(); }",
  "} catch (e) {",
  '  r.error = typeof e?.code === "string" ? e.code : "load-failed";',
  "}",
  `console.log(${JSON.stringify(RUNTIME_PROBE_MARKER)} + JSON.stringify(r));`,
].join("\n");

/** What the probe found in one editor. */
export interface EditorRuntime {
  /** `process.versions.node`, for example `20.18.1`. */
  readonly node: string;
  readonly electron: string | null;
  /** `process.versions.sqlite`: the SQLite Node was built with, when it reports one. */
  readonly sqlite: string | null;
  /** `process.versions.modules`: the native module ABI. */
  readonly modules: string | null;
  /** Whether `require("node:sqlite")` succeeded and gave a working `DatabaseSync`. */
  readonly nodeSqlite: boolean;
  /** `sqlite_version()` from an in-memory database, when `node:sqlite` loaded. */
  readonly sqliteVersion: string | null;
  /** Whether an FTS5 table could be created; null when `node:sqlite` did not load. */
  readonly fts5: boolean | null;
  /** The error code when `node:sqlite` did not load, for example `ERR_UNKNOWN_BUILTIN_MODULE`. */
  readonly error: string | null;
  /** Whether the editor printed Node's `ExperimentalWarning` on stderr while probing. */
  readonly experimentalWarning: boolean;
}

const optionalString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

/**
 * The runtime from the probe's output, or null when no line carries the marker or the line is
 * not what the probe prints. `stderr` only decides `experimentalWarning`.
 */
export function parseRuntimeProbe(stdout: string, stderr = ""): EditorRuntime | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(RUNTIME_PROBE_MARKER));
  if (line === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(RUNTIME_PROBE_MARKER.length));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r["node"] !== "string" ||
    !optionalString(r["electron"]) ||
    !optionalString(r["sqlite"]) ||
    !optionalString(r["modules"]) ||
    typeof r["nodeSqlite"] !== "boolean" ||
    !optionalString(r["sqliteVersion"]) ||
    !(r["fts5"] === null || typeof r["fts5"] === "boolean") ||
    !optionalString(r["error"])
  ) {
    return null;
  }
  return {
    node: r["node"],
    electron: r["electron"],
    sqlite: r["sqlite"],
    modules: r["modules"],
    nodeSqlite: r["nodeSqlite"],
    sqliteVersion: r["sqliteVersion"],
    fts5: r["fts5"],
    error: r["error"],
    experimentalWarning: /ExperimentalWarning/.test(stderr),
  };
}

/** One line for the log, for example `Node 24.22.1, Electron 43.8.10, ...`. */
export function describeRuntime(runtime: EditorRuntime): string {
  const parts = [
    `Node ${runtime.node}`,
    `Electron ${runtime.electron ?? "(none)"}`,
    `SQLite in process.versions ${runtime.sqlite ?? "(none)"}`,
  ];
  if (runtime.nodeSqlite) {
    parts.push(
      `node:sqlite loads (SQLite ${runtime.sqliteVersion ?? "unknown"}, FTS5 ${runtime.fts5 === true ? "yes" : "no"}${runtime.experimentalWarning ? ", ExperimentalWarning" : ""})`,
    );
  } else {
    parts.push(`node:sqlite does not load (${runtime.error ?? "unknown error"})`);
  }
  return parts.join(", ");
}

/**
 * The environment of the probe: the launcher's `base` environment without the editor's own
 * variables (an outer editor's `VSCODE_*` would leak in), plus `ELECTRON_RUN_AS_NODE=1`.
 */
export function probeEnvironment(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !/^(VSCODE_|ELECTRON_)/i.test(name)) env[name] = value;
  }
  env["ELECTRON_RUN_AS_NODE"] = "1";
  return env;
}

/** How long the probe may take. Starting the editor binary as Node takes about a second. */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * Run the probe with the editor binary `executable` as Node. Throws, with the exit status and the
 * start of stderr, when it prints no result.
 */
export function probeEditorRuntime(
  executable: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): EditorRuntime {
  const run = spawnSync(executable, ["-e", RUNTIME_PROBE_SCRIPT], {
    env: probeEnvironment(base),
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime = parseRuntimeProbe(run.stdout ?? "", run.stderr ?? "");
  if (runtime === null) {
    const why = run.error?.message ?? `exit ${String(run.status ?? run.signal)}`;
    throw new Error(
      `the runtime probe printed no result (${why}): ${(run.stderr ?? "").slice(0, 300)}`,
    );
  }
  return runtime;
}
