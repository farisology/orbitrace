/**
 * Sessions that exist only in the history store (#195): `orbitrace list` shows them, and `export`
 * and `open` replay them, through the same session replayer, parser, replay builder and export
 * allow-list as sessions read from files.
 *
 * How (the adapter and the root are core's since #211, shared with the editor extension): the
 * commands search one more source root, the history root, and use an adapter that wraps the
 * Claude Code adapter. For the history root it lists the stored sessions; for a session found
 * there it hands the stored lines (core's `readSession`, already a `SessionInput`) to the
 * replayer instead of opening files. Core lists the file roots first and keeps the first session
 * with a key, so a session whose transcript is still found is always read from its files; only
 * sessions whose transcripts are gone (or are under a folder not searched) come from history.
 *
 * Reads only: the store is opened as a reader for each listing or load and closed again, and
 * the history root is added only when the database file already exists.
 */

import type { SourceAdapter, SourceRoot } from "@orbitrace/core";
import {
  CLAUDE_CODE_RUNTIME,
  historyAwareAdapter,
  historyRoot,
  openHistoryStore,
  toHistoryErrorInfo,
  withoutSqliteWarning,
} from "@orbitrace/core/node";
import type { CliWarning, HostContext } from "../sessions.js";
import {
  capabilityOf,
  locationOptions,
  storeExists,
  tryHistoryLocation,
  type HistoryRuntime,
} from "./context.js";

// The adapter, the root and the locator prefix are core's since #211, shared with the editor
// extension; passed on here under the names the CLI uses.
export {
  HISTORY_LOCATOR_PREFIX,
  historyAwareAdapter,
  historyRoot,
  isHistoryRef,
} from "@orbitrace/core/node";

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
    const store = await withoutSqliteWarning(() => openHistoryStore({ ...options, mode: "read" }));
    store.close();
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
