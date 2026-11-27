/// <reference types="node" />
/**
 * The history store (ticket #25): one SQLite file, opened through `node:sqlite`, that keeps a
 * redacted copy of each transcript line so a session outlives Claude Code's cleanup.
 *
 * Opt-in by design. Importing this module does nothing. Nothing is written until a caller opens a
 * store with `mode: "write"` (which creates the folder and the file) and calls `ingestHistory`.
 * The CLI does so only after the user turned recording on or asked for an ingest (#195).
 *
 * Schema version 1 (`PRAGMA user_version`), one table per level:
 * - `sessions`: one row per session key (`SessionRef.key`), with the runtime, the runtime's
 *   session id, the project label, the last activity and when it was first and last ingested.
 * - `files`: one row per transcript file of a session (`main`, or `subagent` with its agent id),
 *   with the subagent's meta file (redacted JSON), the file's identity (device and inode), the byte
 *   offset read up to, hashes of the first and last 4 KiB before that offset, and a generation
 *   counter that goes up each time the file was found truncated or replaced.
 * - `lines`: one row per stored line, keyed by `(file, base key, occurrence)`. The base key is
 *   `u:<uuid>` for a line with a `uuid`, otherwise `h:<hash of the redacted text>`; the occurrence
 *   counts equal base keys in file order. Rows are read back in insertion order.
 * Later versions (for example full-text search, ticket #28) are added as numbered migrations.
 *
 * Files: WAL journal mode, so readers are not blocked by the writer; `synchronous = NORMAL` (see
 * `openHistoryStore`); `secure_delete` on, so a deleted session's bytes are overwritten, followed
 * by a checkpoint that empties the WAL file when no reader has the store open (`scrub`).
 *
 * One write at a time per store object: the pid lock keeps other processes out, and an in-flight
 * guard keeps two overlapping `ingestHistory` calls on the same store apart (the second waits for
 * the first) and makes `deleteSession` and `scrub` refuse with `locked` while an ingest runs.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { closeSync, existsSync, openSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import type { RawSubagentInput, RawSubagentMeta, SessionInput } from "../model/raw.js";
import { RUNTIME_IDS, type RuntimeId } from "../model/sources.js";
import { claudeCodeSubagentFileName } from "../sources/claude-code/adapter.js";
import type { ProcessAliveCheck } from "../sources/claude-code/registry.js";
import { sqliteEngine, type SqlDatabase, type SqlStatement, type SqlValue } from "./engine.js";
import { HistoryStoreError } from "./errors.js";
import {
  checkHistoryLocation,
  HISTORY_FILE_MODE,
  prepareHistoryDir,
  resolveHistoryLocation,
  restrictHistoryFile,
  type HistoryLocation,
  type HistoryLocationOptions,
} from "./location.js";
import { acquireHistoryLock, type HistoryLock, type HistoryLockOptions } from "./lock.js";

/** The schema version this code writes and reads. */
export const HISTORY_SCHEMA_VERSION = 1;

/** `PRAGMA application_id` of a history store: the bytes `ORBT`. */
export const HISTORY_APPLICATION_ID = 0x4f524254;

/** Each entry upgrades the schema by one version; entry 0 creates version 1. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    runtime TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_label TEXT NOT NULL,
    last_activity INTEGER NOT NULL,
    first_ingested_at INTEGER NOT NULL,
    last_ingested_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('main', 'subagent')),
    agent_id TEXT NOT NULL,
    meta TEXT,
    dev TEXT,
    ino TEXT,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    head_len INTEGER NOT NULL DEFAULT 0,
    head_hash TEXT,
    tail_len INTEGER NOT NULL DEFAULT 0,
    tail_hash TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, role, agent_id)
  ) STRICT;
  CREATE TABLE lines (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    base_key TEXT NOT NULL,
    occurrence INTEGER NOT NULL,
    seen_generation INTEGER NOT NULL,
    text TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX lines_by_key ON lines (file_id, base_key, occurrence);
  CREATE INDEX lines_by_file ON lines (file_id);
  `,
];

/** How a store is opened. */
export interface HistoryOpenOptions extends HistoryLocationOptions {
  /**
   * `write` takes the single-writer lock, creates the folder and the file when missing, and
   * upgrades the schema. `read` takes no lock, writes nothing of its own and fails with
   * `not-found` when there is no store yet. Required, so no caller opens a writer by accident.
   */
  readonly mode: "read" | "write";
  /** Writer only: how long to wait for another writer, in milliseconds. Default 0. */
  readonly lockWaitMs?: number;
  /** Writer only: liveness check for the pid in an existing lock. Default `isProcessAlive`. */
  readonly isProcessAlive?: ProcessAliveCheck;
}

/** Counts of what the store holds. */
export interface HistoryTotals {
  readonly sessions: number;
  readonly files: number;
  readonly lines: number;
}

/** One stored session. Local data: the session id and project label never leave the machine. */
export interface HistorySessionSummary {
  /** `SessionRef.key` of the session when it was ingested. Opaque. */
  readonly key: string;
  readonly runtime: RuntimeId;
  readonly sessionId: string;
  readonly projectLabel: string;
  /** Unix epoch milliseconds. */
  readonly lastActivity: number;
  readonly firstIngestedAt: number;
  readonly lastIngestedAt: number;
  readonly subagentCount: number;
  readonly lineCount: number;
}

/** What `deleteSession` did. */
export interface HistoryDeleteSessionResult {
  /** The session was stored and its rows are now deleted. */
  readonly deleted: boolean;
  /**
   * The WAL file is empty, so no copy of deleted rows is left in it. False when a reader (another
   * process, or another store object) is inside a read and the checkpoint could not finish: the
   * rows are deleted, but their old bytes stay in the WAL file until `scrub` succeeds (or the last
   * connection closes). Close the readers and call `scrub`. True when nothing was deleted.
   */
  readonly scrubbed: boolean;
}

/** One stored subagent transcript, as `parseSession` takes it. */
export interface HistorySubagentInput extends RawSubagentInput {
  readonly lines: readonly string[];
}

/** The stored lines of one session: a `SessionInput` whose lines are arrays. */
export interface HistorySessionInput extends SessionInput {
  readonly main: readonly string[];
  readonly subagents: readonly HistorySubagentInput[];
}

/** An open history store. Calls are synchronous; `close` when done. */
export interface HistoryStore {
  readonly mode: "read" | "write";
  /** Where the store is. Local paths: never sent to the app or written to a log. */
  readonly location: HistoryLocation;
  totals(): HistoryTotals;
  /** Every stored session, newest activity first. */
  listSessions(): readonly HistorySessionSummary[];
  /**
   * The stored lines of one session as a `SessionInput`, ready for `parseSession`: the main
   * transcript's lines and each subagent's lines and meta, in the order they were stored. Null
   * when the key is not stored.
   */
  readSession(key: string): HistorySessionInput | null;
  /**
   * Writer only. Delete one session and everything stored for it, overwrite the freed pages and
   * try to empty the WAL file. See `HistoryDeleteSessionResult`: when a reader is open the WAL
   * cannot be emptied and `scrubbed` is false. Throws `locked` while an ingest on this store runs.
   */
  deleteSession(key: string): HistoryDeleteSessionResult;
  /**
   * Writer only. Checkpoint the WAL into the database and truncate it, so the old bytes of
   * deleted rows are gone from it. True when the WAL file is now empty; false when a reader still
   * holds a read open. Waits at most about half a second. Throws `locked` while an ingest runs.
   */
  scrub(): boolean;
  /** Close the database and, for a writer, release the lock. Safe to call more than once. */
  close(): void;
}

/** A file row as the ingest uses it. */
export interface HistoryFileRow {
  readonly id: number;
  readonly meta: string | null;
  readonly dev: string | null;
  readonly ino: string | null;
  readonly offset: number;
  readonly headLen: number;
  readonly headHash: string | null;
  readonly tailLen: number;
  readonly tailHash: string | null;
  readonly generation: number;
}

/** The new state of a file row after a batch. */
export interface HistoryFileState {
  readonly dev: string;
  readonly ino: string;
  readonly offset: number;
  readonly headLen: number;
  readonly headHash: string | null;
  readonly tailLen: number;
  readonly tailHash: string | null;
  readonly generation: number;
}

/** What the ingest stores for a session. */
export interface HistorySessionRow {
  readonly key: string;
  readonly runtime: RuntimeId;
  readonly sessionId: string;
  readonly projectLabel: string;
  readonly lastActivity: number;
}

function num(value: SqlValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/** A time in whole milliseconds; file times can carry fractions. */
function wholeMs(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

function str(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isRuntimeId(value: string | null): value is RuntimeId {
  return value !== null && (RUNTIME_IDS as readonly string[]).includes(value);
}

function parseMeta(text: string | null): RawSubagentMeta | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as RawSubagentMeta)
      : null;
  } catch {
    return null;
  }
}

/**
 * The store over an open database. Exported for `ingest.ts`; hosts get it as `HistoryStore`
 * from `openHistoryStore`.
 */
export class SqliteHistoryStore implements HistoryStore {
  readonly mode: "read" | "write";
  readonly location: HistoryLocation;
  private db: SqlDatabase | null;
  private readonly lock: HistoryLock | null;
  private readonly statements = new Map<string, SqlStatement>();
  /** Set while an `ingestHistory` call runs on this store. */
  private busy = false;
  /** The end of the queue of `ingestHistory` calls on this store. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    db: SqlDatabase,
    mode: "read" | "write",
    location: HistoryLocation,
    lock: HistoryLock | null,
  ) {
    this.db = db;
    this.mode = mode;
    this.location = location;
    this.lock = lock;
  }

  /**
   * Run `body` (one `ingestHistory`) when the ingests queued before it on this store have ended.
   * Two overlapping ingests would both continue from the same file rows and store lines twice.
   */
  exclusiveWrite<T>(body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.busy = true;
      try {
        return await body();
      } finally {
        this.busy = false;
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Throw `locked` while an ingest runs on this store. */
  private assertIdle(): void {
    if (this.busy) {
      throw new HistoryStoreError(
        "locked",
        "The history store is busy with an ingest. Try again when it has finished.",
      );
    }
  }

  /** The open database, or `not-writable` when closed. */
  private database(): SqlDatabase {
    if (this.db === null)
      throw new HistoryStoreError("not-writable", "The history store is closed.");
    return this.db;
  }

  /** A cached prepared statement. */
  statement(sql: string): SqlStatement {
    const db = this.database();
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Throw unless this is an open writer that still holds its lock. */
  assertWritable(): void {
    this.database();
    if (this.mode !== "write" || this.lock === null) {
      throw new HistoryStoreError("not-writable", "The history store was opened for reading.");
    }
    if (!this.lock.isHeld()) {
      throw new HistoryStoreError(
        "locked",
        "The history store lock was lost to another process. Open the store again.",
      );
    }
  }

  /** Run `body` in one write transaction. Rolls back when it throws. */
  transaction<T>(body: () => T): T {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone.
      }
      throw error;
    }
  }

  /** Insert or update a session row; returns its id. */
  upsertSession(row: HistorySessionRow, now: number): number {
    const result = this.statement(
      `INSERT INTO sessions
         (session_key, runtime, session_id, project_label, last_activity, first_ingested_at, last_ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_key) DO UPDATE SET
         project_label = excluded.project_label,
         last_activity = max(last_activity, excluded.last_activity),
         last_ingested_at = excluded.last_ingested_at
       RETURNING id`,
    ).get(
      row.key,
      row.runtime,
      row.sessionId,
      row.projectLabel,
      wholeMs(row.lastActivity),
      wholeMs(now),
      wholeMs(now),
    );
    return num(result?.["id"]);
  }

  /** Whether a session key is stored. */
  hasSession(key: string): boolean {
    return (
      this.statement("SELECT 1 AS x FROM sessions WHERE session_key = ?").get(key) !== undefined
    );
  }

  /** The file row of a session's transcript, created when missing. */
  fileRow(sessionRowId: number, role: "main" | "subagent", agentId: string): HistoryFileRow {
    this.statement("INSERT OR IGNORE INTO files (session_id, role, agent_id) VALUES (?, ?, ?)").run(
      sessionRowId,
      role,
      agentId,
    );
    const row = this.statement(
      `SELECT id, meta, dev, ino, byte_offset, head_len, head_hash, tail_len, tail_hash, generation
       FROM files WHERE session_id = ? AND role = ? AND agent_id = ?`,
    ).get(sessionRowId, role, agentId);
    if (row === undefined) throw new HistoryStoreError("io", "A history file row is missing.");
    return {
      id: num(row["id"]),
      meta: str(row["meta"]),
      dev: str(row["dev"]),
      ino: str(row["ino"]),
      offset: num(row["byte_offset"]),
      headLen: num(row["head_len"]),
      headHash: str(row["head_hash"]),
      tailLen: num(row["tail_len"]),
      tailHash: str(row["tail_hash"]),
      generation: num(row["generation"]),
    };
  }

  setFileMeta(fileId: number, meta: string): void {
    this.statement("UPDATE files SET meta = ? WHERE id = ?").run(meta, fileId);
  }

  setFileState(fileId: number, state: HistoryFileState): void {
    this.statement(
      `UPDATE files SET dev = ?, ino = ?, byte_offset = ?, head_len = ?, head_hash = ?,
         tail_len = ?, tail_hash = ?, generation = ?
       WHERE id = ?`,
    ).run(
      state.dev,
      state.ino,
      state.offset,
      state.headLen,
      state.headHash,
      state.tailLen,
      state.tailHash,
      state.generation,
      fileId,
    );
  }

  /** Lines of a file with this base key seen in this generation's pass. */
  occurrencesSeen(fileId: number, baseKey: string, generation: number): number {
    const row = this.statement(
      "SELECT count(*) AS n FROM lines WHERE file_id = ? AND base_key = ? AND seen_generation = ?",
    ).get(fileId, baseKey, generation);
    return num(row?.["n"]);
  }

  /** Store a line unless the same key is stored; true when it was added. */
  putLine(
    fileId: number,
    baseKey: string,
    occurrence: number,
    generation: number,
    text: string,
  ): boolean {
    const result = this.statement(
      `INSERT OR IGNORE INTO lines (file_id, base_key, occurrence, seen_generation, text)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fileId, baseKey, occurrence, generation, text);
    if (num(result.changes) > 0) return true;
    this.statement(
      "UPDATE lines SET seen_generation = ? WHERE file_id = ? AND base_key = ? AND occurrence = ?",
    ).run(generation, fileId, baseKey, occurrence);
    return false;
  }

  totals(): HistoryTotals {
    const count = (table: string) =>
      num(this.statement(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
    return { sessions: count("sessions"), files: count("files"), lines: count("lines") };
  }

  listSessions(): readonly HistorySessionSummary[] {
    const rows = this.statement(
      `SELECT s.session_key, s.runtime, s.session_id, s.project_label, s.last_activity,
         s.first_ingested_at, s.last_ingested_at,
         (SELECT count(*) FROM files f WHERE f.session_id = s.id AND f.role = 'subagent') AS subagents,
         (SELECT count(*) FROM lines l JOIN files f ON l.file_id = f.id WHERE f.session_id = s.id) AS line_count
       FROM sessions s ORDER BY s.last_activity DESC, s.session_key`,
    ).all();
    const result: HistorySessionSummary[] = [];
    for (const row of rows) {
      const runtime = str(row["runtime"]);
      if (!isRuntimeId(runtime)) continue;
      result.push({
        key: str(row["session_key"]) ?? "",
        runtime,
        sessionId: str(row["session_id"]) ?? "",
        projectLabel: str(row["project_label"]) ?? "",
        lastActivity: num(row["last_activity"]),
        firstIngestedAt: num(row["first_ingested_at"]),
        lastIngestedAt: num(row["last_ingested_at"]),
        subagentCount: num(row["subagents"]),
        lineCount: num(row["line_count"]),
      });
    }
    return result;
  }

  readSession(key: string): HistorySessionInput | null {
    const session = this.statement("SELECT id FROM sessions WHERE session_key = ?").get(key);
    if (session === undefined) return null;
    const files = this.statement(
      "SELECT id, role, agent_id, meta FROM files WHERE session_id = ?",
    ).all(num(session["id"]));
    const linesOf = (fileId: number): string[] =>
      this.statement("SELECT text FROM lines WHERE file_id = ? ORDER BY id")
        .all(fileId)
        .map((row) => str(row["text"]) ?? "");
    let main: string[] = [];
    const subagents: HistorySubagentInput[] = [];
    for (const file of files) {
      const fileId = num(file["id"]);
      if (str(file["role"]) === "main") {
        main = linesOf(fileId);
        continue;
      }
      subagents.push({
        agentId: str(file["agent_id"]) ?? "",
        meta: parseMeta(str(file["meta"])),
        lines: linesOf(fileId),
      });
    }
    // Sorted by file name, as the Claude Code adapter sorts its files.
    subagents.sort((a, b) => {
      const x = claudeCodeSubagentFileName(a.agentId);
      const y = claudeCodeSubagentFileName(b.agentId);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return { main, subagents };
  }

  deleteSession(key: string): HistoryDeleteSessionResult {
    this.assertWritable();
    this.assertIdle();
    const result = this.statement("DELETE FROM sessions WHERE session_key = ?").run(key);
    const deleted = num(result.changes) > 0;
    return { deleted, scrubbed: deleted ? this.checkpoint() : true };
  }

  scrub(): boolean {
    this.assertWritable();
    this.assertIdle();
    return this.checkpoint();
  }

  /**
   * `wal_checkpoint(TRUNCATE)`, checked. A reader inside a read transaction makes it give up after
   * the busy timeout with `busy = 1` and no error, so the result row is read, and the WAL file is
   * checked to be empty. Tried a few times with a short busy timeout, so a caller is not blocked
   * for the full 5 s timeout of ordinary statements.
   */
  private checkpoint(): boolean {
    const db = this.database();
    const walFile = `${this.location.dbFile}-wal`;
    db.exec(`PRAGMA busy_timeout = ${CHECKPOINT_BUSY_MS}`);
    try {
      for (let attempt = 0; attempt < CHECKPOINT_ATTEMPTS; attempt += 1) {
        const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        const busy = num(row?.["busy"]);
        const log = num(row?.["log"]);
        const checkpointed = num(row?.["checkpointed"]);
        if (busy === 0 && log === checkpointed && walSize(walFile) === 0) return true;
      }
      return false;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  close(): void {
    const db = this.db;
    if (db === null) return;
    this.db = null;
    this.statements.clear();
    try {
      db.close();
    } finally {
      this.lock?.release();
    }
  }
}

/** Busy timeout of ordinary statements, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;
/** Busy timeout of one checkpoint attempt, and how many attempts `scrub` makes. */
const CHECKPOINT_BUSY_MS = 150;
const CHECKPOINT_ATTEMPTS = 3;

/** Size of the WAL file; 0 when it is missing. */
function walSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** The file names SQLite may keep beside the database. */
function sidecarFiles(dbFile: string): readonly string[] {
  return [`${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`];
}

function pragmaNumber(db: SqlDatabase, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? 0 : num(Object.values(row)[0]);
}

/** Settings every connection uses. */
function configure(db: SqlDatabase): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA secure_delete = ON");
}

/** Check the file is ours, then apply the migrations it lacks (writer) or refuse (reader). */
function prepareSchema(db: SqlDatabase, mode: "read" | "write"): void {
  const applicationId = pragmaNumber(db, "application_id");
  const version = pragmaNumber(db, "user_version");
  const empty = version === 0 && applicationId === 0;
  if (!empty && applicationId !== HISTORY_APPLICATION_ID) {
    throw new HistoryStoreError("not-a-store", "The file is not an Orbitrace history store.");
  }
  if (version > HISTORY_SCHEMA_VERSION) {
    throw new HistoryStoreError(
      "newer-schema",
      "The history store was written by a newer version of Orbitrace.",
    );
  }
  if (version === HISTORY_SCHEMA_VERSION) return;
  if (mode === "read") {
    throw new HistoryStoreError(
      empty ? "not-found" : "needs-upgrade",
      empty
        ? "There is no history store yet."
        : "The history store needs an upgrade; open it for writing once.",
    );
  }
  if (empty) {
    const tables = num(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get()?.["n"],
    );
    if (tables > 0) {
      throw new HistoryStoreError("not-a-store", "The file is not an Orbitrace history store.");
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let next = version; next < HISTORY_SCHEMA_VERSION; next += 1) {
      db.exec(MIGRATIONS[next] ?? "");
      db.exec(`PRAGMA user_version = ${next + 1}`);
    }
    db.exec(`PRAGMA application_id = ${HISTORY_APPLICATION_ID}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back.
    }
    throw error;
  }
}

async function requireEngine() {
  const engine = await sqliteEngine();
  if (engine.module === null || !engine.capability.available) {
    throw new HistoryStoreError(
      "unavailable",
      engine.capability.available ? "node:sqlite is not available." : engine.capability.reason,
    );
  }
  return engine.module;
}

/**
 * Open the history store. See `HistoryOpenOptions` for the two modes. Throws a
 * `HistoryStoreError`: `unavailable` when `node:sqlite` cannot be loaded, `unsafe-location`,
 * `locked`, `not-found` (reader), `not-a-store`, `newer-schema`, `needs-upgrade` (reader) or
 * `io`. No message names a path.
 */
export function openHistoryStore(options: HistoryOpenOptions): Promise<HistoryStore> {
  return openStore(options, undefined);
}

/**
 * Open a writer whose lock file carries `lockToken`. Internal, for the worker entry: the parent
 * makes the token before it starts the worker, so it can remove the lock however the worker ends.
 * Not exported from `@orbitrace/core/node`.
 */
export function openHistoryWriterWithLockToken(
  options: Omit<HistoryOpenOptions, "mode">,
  lockToken: string,
): Promise<HistoryStore> {
  return openStore({ ...options, mode: "write" }, lockToken);
}

async function openStore(
  options: HistoryOpenOptions,
  lockToken: string | undefined,
): Promise<HistoryStore> {
  const sqlite = await requireEngine();
  const location = resolveHistoryLocation(options);
  checkHistoryLocation(location, options);

  if (options.mode === "read") {
    if (!existsSync(location.dbFile)) {
      throw new HistoryStoreError("not-found", "There is no history store yet.");
    }
    let db: SqlDatabase | null = null;
    try {
      db = new sqlite.DatabaseSync(location.dbFile);
      configure(db);
      db.exec("PRAGMA query_only = ON");
      prepareSchema(db, "read");
      return new SqliteHistoryStore(db, "read", location, null);
    } catch (error) {
      db?.close();
      throw openError(error);
    }
  }

  prepareHistoryDir(location);
  const lockOptions: HistoryLockOptions = {
    ...(options.lockWaitMs === undefined ? {} : { waitMs: options.lockWaitMs }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    ...(lockToken === undefined ? {} : { token: lockToken }),
  };
  const lock = await acquireHistoryLock(location.lockFile, lockOptions);
  let db: SqlDatabase | null = null;
  try {
    // Create the file with owner-only permissions before SQLite opens it; SQLite gives its WAL
    // and shared-memory files the same permissions as the database file.
    closeSync(openSync(location.dbFile, "a", HISTORY_FILE_MODE));
    restrictHistoryFile(location.dbFile);
    db = new sqlite.DatabaseSync(location.dbFile);
    configure(db);
    db.exec("PRAGMA journal_mode = WAL");
    // In WAL mode NORMAL keeps the file consistent after a crash or power loss, but a power loss
    // can roll back the last commits. Safe here: each file's offset commits in the same
    // transaction as its lines, so the next run re-reads exactly the lost lines. FULL's fsync on
    // every commit would buy nothing.
    db.exec("PRAGMA synchronous = NORMAL");
    prepareSchema(db, "write");
    for (const file of sidecarFiles(location.dbFile)) restrictHistoryFile(file);
    return new SqliteHistoryStore(db, "write", location, lock);
  } catch (error) {
    try {
      db?.close();
    } finally {
      lock.release();
    }
    throw openError(error);
  }
}

/** SQLite's result code for a file that is not a database. */
const SQLITE_NOTADB = 26;

/** The `HistoryStoreError` for a failure while opening, without the underlying message. */
function openError(error: unknown): HistoryStoreError {
  if (error instanceof HistoryStoreError) return error;
  if ((error as { errcode?: unknown } | null)?.errcode === SQLITE_NOTADB) {
    return new HistoryStoreError("not-a-store", "The file is not an Orbitrace history store.");
  }
  return new HistoryStoreError("io", "The history store could not be opened.");
}

/** Options of `deleteHistoryStore`. */
export interface HistoryDeleteOptions extends HistoryLocationOptions {
  /** How long to wait for a running writer, in milliseconds. Default 0. */
  readonly lockWaitMs?: number;
  readonly isProcessAlive?: ProcessAliveCheck;
}

/**
 * Delete the whole history store: the database file and the files SQLite keeps beside it, then
 * the lock, then the folder when nothing else is in it. Takes the writer lock first, so it fails
 * with `locked` while another writer runs. Works without `node:sqlite`. Returns whether a
 * database file was there.
 */
export async function deleteHistoryStore(options: HistoryDeleteOptions = {}): Promise<boolean> {
  const location = resolveHistoryLocation(options);
  checkHistoryLocation(location, options);
  if (!existsSync(location.dir)) return false;
  const lock = await acquireHistoryLock(location.lockFile, {
    ...(options.lockWaitMs === undefined ? {} : { waitMs: options.lockWaitMs }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  });
  let existed = false;
  try {
    for (const file of [location.dbFile, ...sidecarFiles(location.dbFile)]) {
      try {
        unlinkSync(file);
        if (file === location.dbFile) existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new HistoryStoreError("io", "A history store file could not be deleted.");
        }
      }
    }
  } finally {
    lock.release();
  }
  try {
    rmdirSync(location.dir);
  } catch {
    // Not empty (a folder the user chose may hold other files), or already gone.
  }
  return existed;
}
