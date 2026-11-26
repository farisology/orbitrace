/**
 * The Sessions view (vscode glue). Rows come from the session catalog; their text from
 * `session-labels.ts`. Clicking a row runs "Visualise session..." with that row.
 */

import * as vscode from "vscode";
import { COMMANDS } from "./commands.js";
import {
  GROUP_TITLES,
  childNodes,
  topLevelNodes,
  type CatalogEntry,
  type SessionCatalog,
  type SessionTreeNode,
} from "./session-catalog.js";
import { describeSession } from "./session-labels.js";

/** Shown in the view when the session folders cannot be read. */
export const LIST_FAILED_MESSAGE = "The Claude Code session folders could not be read.";

export interface SessionTreeOptions {
  readonly catalog: SessionCatalog;
  workspacePaths(): readonly string[];
  /** Called after each load with an error text, or undefined when the load worked. */
  onLoaded?(message: string | undefined): void;
  /** Clock, for tests. Default `Date.now`. */
  now?(): number;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeNode> {
  private readonly changed = new vscode.EventEmitter<SessionTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private entries: readonly CatalogEntry[] = [];

  constructor(private readonly options: SessionTreeOptions) {}

  /** Entries of the last load. */
  get lastEntries(): readonly CatalogEntry[] {
    return this.entries;
  }

  /** List the sessions again. */
  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(node?: SessionTreeNode): Promise<SessionTreeNode[]> {
    if (node !== undefined) return childNodes(node);
    try {
      this.entries = await this.options.catalog.list(this.options.workspacePaths());
      this.options.onLoaded?.(undefined);
    } catch {
      this.entries = [];
      this.options.onLoaded?.(LIST_FAILED_MESSAGE);
    }
    return topLevelNodes(this.entries);
  }

  getTreeItem(node: SessionTreeNode): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        GROUP_TITLES[node.group],
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = String(node.entries.length);
      item.contextValue = `orbitrace.group.${node.group}`;
      return item;
    }
    const text = describeSession(node.entry.summary, (this.options.now ?? Date.now)());
    const item = new vscode.TreeItem(text.label, vscode.TreeItemCollapsibleState.None);
    item.description = text.description;
    item.tooltip = text.tooltip;
    const live = node.entry.summary.live === "busy" || node.entry.summary.live === "idle";
    item.iconPath = new vscode.ThemeIcon(live ? "pulse" : "history");
    item.contextValue = "orbitrace.session";
    item.command = {
      command: COMMANDS.visualiseSession,
      title: "Visualise",
      arguments: [node],
    };
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
