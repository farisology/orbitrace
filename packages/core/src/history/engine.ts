/// <reference types="node" />
/**
 * The storage engine of the history store (ticket #25): `node:sqlite`, the SQLite built into
 * Node, found by feature detection. Nothing here runs when the module is imported; the engine is
 * loaded by the first call to `historyCapability` or `openHistoryStore`.
 *
 * Measured (docs/decisions/0001-storage.md): `node:sqlite` loads without a flag on Node 22.13.1,
 * 22.23.5, 23.11.1, 24.22.3 and 26.5.0, and is missing on Node 20.20.2 and on 22.12.0 without
 * `--experimental-sqlite`. Where it is missing (Node 20, older editor hosts) the capability is
 * `unavailable` with a reason, and every other part of core works as before. Node 22 and 23 print
 * one `ExperimentalWarning` when the module is first loaded; Node 24.22.3 and 26.5.0 print none.
 *
 * The types below describe only the part of the `node:sqlite` API this store uses. They are
 * written here because `@types/node` 20 (the floor this repository builds with) has no
 * declarations for the module.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

/** A value SQLite accepts as a bound parameter or returns in a row. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** The result of `StatementSync.run`. */
export interface SqlRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

/** The part of `StatementSync` the store uses. */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlValue>[];
}

/** The part of `DatabaseSync` the store uses. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** The part of the `node:sqlite` module the store uses. */
export interface SqliteModule {
  readonly DatabaseSync: new (path: string) => SqlDatabase;
}

/** Whether the history store can run in this process, and why not when it cannot. */
export type HistoryCapability =
  | {
      readonly available: true;
      /** `node:sqlite`. */
      readonly engine: "node:sqlite";
      /** `process.version`, for example `v24.22.3`. */
      readonly nodeVersion: string;
      /** The SQLite library version, from `sqlite_version()`. */
      readonly sqliteVersion: string;
      /**
       * Whether this SQLite was built with FTS5 (full-text search, ticket #28). Measured: missing
       * in Node 22.13.1 and 23.11.1, present in Node 22.23.5, 24.22.3 and 26.5.0.
       */
      readonly fts5: boolean;
    }
  | {
      readonly available: false;
      readonly engine: "node:sqlite";
      readonly nodeVersion: string;
      /** One line for a person, with no path in it. */
      readonly reason: string;
    };

/** Loads a module by its specifier. The default is the dynamic `import()`. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

const SQLITE_SPECIFIER = "node:sqlite";

// A specifier in a variable keeps bundlers and the type checker from resolving it at build time.
const defaultImporter: ModuleImporter = (specifier) => import(/* @vite-ignore */ specifier);

function isSqliteModule(value: unknown): value is SqliteModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { DatabaseSync?: unknown }).DatabaseSync === "function"
  );
}

/** What `loadSqlite` found: the module and the capability, or the capability alone. */
export interface SqliteLoad {
  readonly module: SqliteModule | null;
  readonly capability: HistoryCapability;
}

/** A short reason without the underlying message, which can name a path. */
function reasonFor(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_UNKNOWN_BUILTIN_MODULE") {
    return `This Node.js (${process.version}) has no node:sqlite module. History needs Node 22.13 or later.`;
  }
  return `node:sqlite could not be loaded in this Node.js (${process.version}).`;
}

/**
 * Load `node:sqlite` with `importer` and describe what was found. Never throws. Exported for the
 * tests, which pass an importer that fails; hosts call `historyCapability`.
 */
export async function loadSqlite(importer: ModuleImporter = defaultImporter): Promise<SqliteLoad> {
  const nodeVersion = process.version;
  let loaded: unknown;
  try {
    loaded = await importer(SQLITE_SPECIFIER);
  } catch (error) {
    return {
      module: null,
      capability: {
        available: false,
        engine: "node:sqlite",
        nodeVersion,
        reason: reasonFor(error),
      },
    };
  }
  if (!isSqliteModule(loaded)) {
    return {
      module: null,
      capability: {
        available: false,
        engine: "node:sqlite",
        nodeVersion,
        reason: `node:sqlite in this Node.js (${nodeVersion}) does not have DatabaseSync.`,
      },
    };
  }
  try {
    const probe = new loaded.DatabaseSync(":memory:");
    try {
      const row = probe.prepare("SELECT sqlite_version() AS v").get();
      const sqliteVersion = typeof row?.["v"] === "string" ? row["v"] : "unknown";
      let fts5 = true;
      try {
        probe.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(x)");
      } catch {
        fts5 = false;
      }
      return {
        module: loaded,
        capability: { available: true, engine: "node:sqlite", nodeVersion, sqliteVersion, fts5 },
      };
    } finally {
      probe.close();
    }
  } catch {
    return {
      module: null,
      capability: {
        available: false,
        engine: "node:sqlite",
        nodeVersion,
        reason: `node:sqlite in this Node.js (${nodeVersion}) could not open a database.`,
      },
    };
  }
}

let cached: Promise<SqliteLoad> | undefined;

/** The engine of this process, loaded once. */
export function sqliteEngine(): Promise<SqliteLoad> {
  cached ??= loadSqlite();
  return cached;
}

/**
 * Whether the history store can run in this process. Loads `node:sqlite` on the first call (on
 * Node 22.x that prints Node's `ExperimentalWarning` once) and opens an in-memory database to
 * read its version; writes nothing. Never throws.
 */
export async function historyCapability(): Promise<HistoryCapability> {
  return (await sqliteEngine()).capability;
}
