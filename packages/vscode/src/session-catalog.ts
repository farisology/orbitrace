/**
 * The sessions the editor shows, and which one "Visualise current session" opens.
 *
 * Lists through the shared session replayer, then looks up each session's `SessionRef` (from
 * the replayer's memory, no second listing) to tell whether it belongs to the open workspace.
 * What leaves this module is a `SessionSummary` plus that yes/no: no path, no locator. No
 * vscode dependency, so it is unit tested.
 */

import type { SessionSummary } from "@orbitrace/core";
import type { SessionReplayer } from "@orbitrace/core/node";
import { sessionInWorkspace } from "./workspace-match.js";

/** One row of the session list. */
export interface CatalogEntry {
  readonly summary: SessionSummary;
  /** Recorded in one of the open workspace folders. */
  readonly inWorkspace: boolean;
}

/** What "Visualise current session" opens. */
export type SessionPick =
  | {
      readonly kind: "session";
      readonly entry: CatalogEntry;
      /** `workspace`: newest session of the workspace. `recent`: newest session anywhere. */
      readonly reason: "workspace" | "recent";
    }
  | {
      readonly kind: "demo";
      /** `none`: no session was found. `error`: the sessions could not be listed. */
      readonly reason: "none" | "error";
    };

export type CatalogReplayer = Pick<SessionReplayer, "list" | "find">;

export interface SessionCatalog {
  /**
   * Every session, those of the workspace folders first, each group newest first. Rejects
   * when the sessions cannot be listed.
   */
  list(workspacePaths: readonly string[]): Promise<readonly CatalogEntry[]>;
  /**
   * The newest session of the workspace, else the newest session, else the demo. Never
   * rejects: a listing failure picks the demo with reason `error`.
   */
  pick(workspacePaths: readonly string[]): Promise<SessionPick>;
}

/** Workspace sessions first; the order inside each group is kept. */
export function workspaceFirst(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return [
    ...entries.filter((entry) => entry.inWorkspace),
    ...entries.filter((entry) => !entry.inWorkspace),
  ];
}

/** Create a catalog over a session replayer. */
export function createSessionCatalog(replayer: CatalogReplayer): SessionCatalog {
  async function list(workspacePaths: readonly string[]): Promise<readonly CatalogEntry[]> {
    const summaries = await replayer.list();
    const entries = await Promise.all(
      summaries.map(async (summary): Promise<CatalogEntry> => {
        let inWorkspace = false;
        if (workspacePaths.length > 0) {
          try {
            inWorkspace = sessionInWorkspace(await replayer.find(summary.key), workspacePaths);
          } catch {
            // A session that vanished between the listing and the lookup is just not matched.
          }
        }
        return { summary, inWorkspace };
      }),
    );
    // The replayer lists newest first; keep that order inside each group.
    return workspaceFirst(entries);
  }

  async function pick(workspacePaths: readonly string[]): Promise<SessionPick> {
    let entries: readonly CatalogEntry[];
    try {
      entries = await list(workspacePaths);
    } catch {
      return { kind: "demo", reason: "error" };
    }
    const first = entries[0];
    if (first === undefined) return { kind: "demo", reason: "none" };
    return { kind: "session", entry: first, reason: first.inWorkspace ? "workspace" : "recent" };
  }

  return { list, pick };
}

/** A node of the Sessions view. */
export type SessionTreeNode =
  | {
      readonly kind: "group";
      readonly group: "workspace" | "other";
      readonly entries: readonly CatalogEntry[];
    }
  | { readonly kind: "session"; readonly entry: CatalogEntry };

/** Group titles of the Sessions view. */
export const GROUP_TITLES = { workspace: "This workspace", other: "Other projects" } as const;

/**
 * The top level of the Sessions view. With sessions both in and outside the workspace, two
 * groups (workspace first); otherwise the sessions themselves, so a single kind of session
 * needs no extra click. No sessions: no nodes, so the view shows its welcome message.
 */
export function topLevelNodes(entries: readonly CatalogEntry[]): SessionTreeNode[] {
  const inside = entries.filter((entry) => entry.inWorkspace);
  const outside = entries.filter((entry) => !entry.inWorkspace);
  if (inside.length > 0 && outside.length > 0) {
    return [
      { kind: "group", group: "workspace", entries: inside },
      { kind: "group", group: "other", entries: outside },
    ];
  }
  return entries.map((entry) => ({ kind: "session", entry }));
}

/** The children of a node: the sessions of a group, nothing for a session. */
export function childNodes(node: SessionTreeNode): SessionTreeNode[] {
  return node.kind === "group" ? node.entries.map((entry) => ({ kind: "session", entry })) : [];
}
