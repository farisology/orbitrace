/// <reference types="node" />
/**
 * Sessions that exist only in the history store (#195, shared by both hosts since #211): a host
 * lists them, and replays them, through the same session replayer, parser, replay builder and
 * export allow-list as sessions read from files.
 *
 * How: the host searches one more source root, the history root (`historyRoot`), and uses an
 * adapter that wraps the Claude Code adapter (`historyAwareAdapter`). For the history root it
 * lists the stored sessions; for a session found there it hands the stored lines
 * (`HistoryStore.readSession`, already a `SessionInput`) to the replayer instead of opening files.
 * Core lists the file roots first and keeps the first session with a key, so a session whose
 * transcript is still found is always read from its files; only sessions whose transcripts are
 * gone (or are under a folder not searched) come from history.
 *
 * Reads only: the store is opened as a reader for each listing or load and closed again. A host
 * adds the history root only when the database file already exists and `historyCapability()`
 * says the store can run, so with no store nothing is loaded, opened or created.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import type { SessionInput } from "../model/raw.js";
import type {
  ListSessionsOptions,
  SessionRef,
  SourceAdapter,
  SourceRoot,
} from "../model/sources.js";
import { CLAUDE_CODE_RUNTIME } from "../sources/claude-code/adapter.js";
import type { HistoryLocationOptions } from "./location.js";
import { withoutSqliteWarning } from "./quiet.js";
import { openHistoryStore, type HistoryStore } from "./store.js";

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
export function isHistoryRef(ref: Pick<SessionRef, "locator">): boolean {
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
  return stored
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
}

/**
 * The adapter a host uses: the Claude Code adapter, plus the history store for refs and roots
 * that come from it. `dbFile` is the store's database file; `options` locate it.
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
