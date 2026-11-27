/**
 * Sessions that exist only in the history store (#195): `orbitrace list` shows them, and `export`
 * and `open` replay them, through the same session replayer, parser, replay builder and export
 * allow-list as sessions read from files.
 *
 * How: the commands search one more source root, the history root, and use an adapter that wraps
 * the Claude Code adapter. For the history root it lists the stored sessions; for a session found
 * there it hands the stored lines (core's `readSession`, already a `SessionInput`) to the
 * replayer instead of opening files. Core lists the file roots first and keeps the first session
 * with a key, so a session whose transcript is still found is always read from its files; only
 * sessions whose transcripts are gone (or are under a folder not searched) come from history.
 *
 * Reads only: the store is opened as a reader for each listing or load and closed again, and
 * the history root is added only when the database file already exists.
 */

import type {
  ListSessionsOptions,
  SessionInput,
  SessionRef,
  SourceAdapter,
  SourceRoot,
} from "@orbitrace/core";
import {
  CLAUDE_CODE_RUNTIME,
  openHistoryStore,
  toHistoryErrorInfo,
  withoutSqliteWarning,
  type HistoryLocationOptions,
  type HistoryStore,
} from "@orbitrace/core/node";
import type { CliWarning, HostContext } from "../sessions.js";
import {
  capabilityOf,
  locationOptions,
  storeExists,
  tryHistoryLocation,
  type HistoryRuntime,
} from "./context.js";

/** The locator of a session read from the history store: this prefix and the session key. */
export const HISTORY_LOCATOR_PREFIX = "orbitrace-history:";

/**
 * The source root that stands for the history store. Its `root` is the database file (local
 * only, like every root); `resolvedBy` is `extra-root` because, like the desktop app's folders,
 * it is searched after the config folders.
 */
export function historyRoot(dbFile: string): SourceRoot {
  return { runtime: CLAUDE_CODE_RUNTIME, root: dbFile, resolvedBy: "extra-root", available: true };
}

/** Whether a root is the history root of `dbFile`. */
function isHistoryRootOf(root: SourceRoot, dbFile: string): boolean {
  return root.runtime === CLAUDE_CODE_RUNTIME && root.root === dbFile;
}

/** Whether a session was found in the history store rather than in files. */
export function isHistoryRef(ref: SessionRef): boolean {
  return ref.locator.startsWith(HISTORY_LOCATOR_PREFIX);
}

/** Open a reader, run `body`, close it. */
async function withReader<T>(
  options: HistoryLocationOptions,
  body: (store: HistoryStore) => T,
): Promise<T> {
  const store = await withoutSqliteWarning(() => openHistoryStore({ ...options, mode: "read" }));
  try {
    return body(store);
  } finally {
    store.close();
  }
}

/** The stored sessions as `SessionRef`s under the history root, newest first. */
async function listStored(
  options: HistoryLocationOptions,
  root: SourceRoot,
  listOptions: ListSessionsOptions = {},
): Promise<readonly SessionRef[]> {
  const stored = await withReader(options, (store) => store.listSessions());
  const refs = stored
    .filter(
      (session) => listOptions.since === undefined || session.lastActivity >= listOptions.since,
    )
    .map((session): SessionRef => ({
      key: session.key,
      runtime: session.runtime,
      source: root,
      projectLabel: session.projectLabel,
      sessionId: session.sessionId,
      lastActivity: session.lastActivity,
      // Its transcript is not where it was found, so it is not being written.
      live: "ended",
      subagentCount: session.subagentCount,
      locator: `${HISTORY_LOCATOR_PREFIX}${session.key}`,
    }));
  return refs;
}

/**
 * The adapter the commands use: the Claude Code adapter, plus the history store for refs and
 * roots that come from it. `dbFile` is the store's database file; `options` locate it.
 */
export function historyAwareAdapter(
  base: SourceAdapter,
  dbFile: string,
  options: HistoryLocationOptions,
): SourceAdapter {
  const baseWatch = base.watchSession?.bind(base);
  return {
    runtime: base.runtime,
    displayName: base.displayName,
    resolveRoots: (context) => base.resolveRoots(context),
    listSessions: (root, listOptions) =>
      isHistoryRootOf(root, dbFile)
        ? listStored(options, root, listOptions)
        : base.listSessions(root, listOptions),
    openSession: async (ref): Promise<SessionInput> => {
      if (!isHistoryRef(ref)) return base.openSession(ref);
      const input = await withReader(options, (store) => store.readSession(ref.key));
      if (input === null) throw new Error("The session is no longer in the history store.");
      return input;
    },
    ...(baseWatch === undefined
      ? {}
      : {
          // A stored session does not change while it is shown: nothing to watch.
          watchSession: (ref: SessionRef, listener: Parameters<typeof baseWatch>[1]) =>
            isHistoryRef(ref) ? () => undefined : baseWatch(ref, listener),
        }),
  };
}

/** The history root to search and the adapters to use, or none, with any warning. */
export interface HistorySearch {
  /** The history root, when the store exists and can be read here. */
  readonly root: SourceRoot | null;
  /** The adapters for the commands: `historyAwareAdapter` over `base` when there is a store. */
  readonly adapters: readonly SourceAdapter[];
  readonly warnings: readonly CliWarning[];
}

/**
 * Whether to search the history store too, for `list`, `export` and `open`. Only when its
 * database file exists already: with no store nothing is loaded, opened or created. When the
 * store is there but cannot be read here (this Node has no `node:sqlite`, or the file is from a
 * newer Orbitrace), the commands go on without it and say so in a warning.
 */
export async function historySearch(
  host: HostContext,
  runtime: HistoryRuntime,
  base: readonly SourceAdapter[],
): Promise<HistorySearch> {
  const none: HistorySearch = { root: null, adapters: base, warnings: [] };
  const location = tryHistoryLocation(host);
  if (location === null || !storeExists(location)) return none;
  const unreadable = (reason: string): HistorySearch => ({
    ...none,
    warnings: [
      {
        code: "history-unavailable",
        message: `Sessions in the history store are not listed: ${reason}`,
      },
    ],
  });
  const capability = await capabilityOf(runtime);
  if (!capability.available) return unreadable(capability.reason);
  const options = locationOptions(host);
  try {
    await withReader(options, () => undefined);
  } catch (error) {
    return unreadable(toHistoryErrorInfo(error).message);
  }
  return {
    root: historyRoot(location.dbFile),
    adapters: base.map((adapter) =>
      adapter.runtime === CLAUDE_CODE_RUNTIME
        ? historyAwareAdapter(adapter, location.dbFile, options)
        : adapter,
    ),
    warnings: [],
  };
}

/**
 * For `open`, which runs for a long time: the history root on each listing, once the store
 * exists. Recording may create it after the start. Never throws.
 */
export async function historyRootNow(
  host: HostContext,
  runtime: HistoryRuntime,
): Promise<SourceRoot | null> {
  try {
    const location = tryHistoryLocation(host);
    if (location === null || !storeExists(location)) return null;
    const capability = await capabilityOf(runtime);
    return capability.available ? historyRoot(location.dbFile) : null;
  } catch {
    return null;
  }
}
