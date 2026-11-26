/**
 * What the three commands do: Visualise current session, Visualise session..., Open demo.
 * The editor UI (quick pick, notifications) and opening a panel are passed in, so this module
 * has no vscode dependency and is unit tested; `extension.ts` wires it to the real API.
 */

import type { SessionSummary } from "@orbitrace/core";
import type { CatalogEntry, SessionCatalog } from "./session-catalog.js";

/** What an editor tab shows. */
export type PanelTarget =
  | { readonly kind: "session"; readonly key: string; readonly summary: SessionSummary }
  | { readonly kind: "demo" };

/** Command ids, as in package.json `contributes.commands`. */
export const COMMANDS = {
  visualiseCurrent: "orbitrace.visualiseCurrent",
  visualiseSession: "orbitrace.visualiseSession",
  openDemo: "orbitrace.openDemo",
  refreshSessions: "orbitrace.refreshSessions",
} as const;

/** Notification texts. No path, key or session id. */
export const COMMAND_MESSAGES = {
  noSessions: "No Claude Code sessions were found on this machine. Showing the demo.",
  listFailed: "The Claude Code session folders could not be read. Showing the demo.",
  notInWorkspace: "No session was found for this workspace. Showing the most recent session.",
  sessionGone: "That session is no longer available. Refresh the Sessions view.",
  openFailed: "Orbitrace could not open the editor tab.",
} as const;

export interface CommandDeps {
  readonly catalog: SessionCatalog;
  /** File system paths of the open workspace folders. */
  workspacePaths(): readonly string[];
  /** Open (or reveal) the editor tab for a target. May throw. */
  open(target: PanelTarget): void;
  /** Let the user choose one session. Resolves undefined when dismissed. */
  chooseSession(entries: readonly CatalogEntry[]): Promise<CatalogEntry | undefined>;
  showInfo(message: string): void;
  showError(message: string): void;
}

export interface CommandHandlers {
  visualiseCurrent(): Promise<void>;
  /**
   * With a session key (string) or a Sessions view row (`{ entry }`), open that session;
   * otherwise ask the user to choose one.
   */
  visualiseSession(argument?: unknown): Promise<void>;
  openDemo(): Promise<void>;
}

/**
 * The Sessions view row a command argument carries (`{ entry: CatalogEntry }`), or null. The
 * row came from this extension's own tree, but the shape is still checked.
 */
export function entryFromArgument(argument: unknown): CatalogEntry | null {
  if (typeof argument !== "object" || argument === null) return null;
  const entry = (argument as { entry?: unknown }).entry;
  if (typeof entry !== "object" || entry === null) return null;
  const { summary, inWorkspace } = entry as { summary?: unknown; inWorkspace?: unknown };
  if (typeof summary !== "object" || summary === null || typeof inWorkspace !== "boolean") {
    return null;
  }
  const { key, projectLabel } = summary as { key?: unknown; projectLabel?: unknown };
  if (typeof key !== "string" || key === "" || typeof projectLabel !== "string") return null;
  return entry as CatalogEntry;
}

/** The session key a command argument names (a string, or a Sessions view row), or null. */
export function keyFromArgument(argument: unknown): string | null {
  if (typeof argument === "string") return argument === "" ? null : argument;
  return entryFromArgument(argument)?.summary.key ?? null;
}

/** Message of an error from opening a panel: our own message when it is one, else a fixed one. */
function openErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : COMMAND_MESSAGES.openFailed;
}

export function createCommandHandlers(deps: CommandDeps): CommandHandlers {
  const open = (target: PanelTarget): void => {
    try {
      deps.open(target);
    } catch (error) {
      deps.showError(openErrorMessage(error));
    }
  };
  const openEntry = (entry: CatalogEntry): void =>
    open({ kind: "session", key: entry.summary.key, summary: entry.summary });

  async function listOrDemo(): Promise<readonly CatalogEntry[] | null> {
    try {
      const entries = await deps.catalog.list(deps.workspacePaths());
      if (entries.length > 0) return entries;
      deps.showInfo(COMMAND_MESSAGES.noSessions);
    } catch {
      deps.showError(COMMAND_MESSAGES.listFailed);
    }
    open({ kind: "demo" });
    return null;
  }

  return {
    async visualiseCurrent(): Promise<void> {
      const workspacePaths = deps.workspacePaths();
      const pick = await deps.catalog.pick(workspacePaths);
      if (pick.kind === "demo") {
        if (pick.reason === "error") deps.showError(COMMAND_MESSAGES.listFailed);
        else deps.showInfo(COMMAND_MESSAGES.noSessions);
        open({ kind: "demo" });
        return;
      }
      if (pick.reason === "recent" && workspacePaths.length > 0) {
        deps.showInfo(COMMAND_MESSAGES.notInWorkspace);
      }
      openEntry(pick.entry);
    },

    async visualiseSession(argument?: unknown): Promise<void> {
      // A row of the Sessions view carries its entry: open it without listing again.
      const row = entryFromArgument(argument);
      if (row !== null) {
        openEntry(row);
        return;
      }
      const key = keyFromArgument(argument);
      const entries = await listOrDemo();
      if (entries === null) return;
      if (key !== null) {
        const entry = entries.find((candidate) => candidate.summary.key === key);
        if (entry === undefined) deps.showError(COMMAND_MESSAGES.sessionGone);
        else openEntry(entry);
        return;
      }
      const chosen = await deps.chooseSession(entries);
      if (chosen !== undefined) openEntry(chosen);
    },

    async openDemo(): Promise<void> {
      open({ kind: "demo" });
    },
  };
}
