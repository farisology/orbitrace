/**
 * Extension entry (vscode glue). Bundled with esbuild into one CommonJS file,
 * dist/extension.js, with @orbitrace/core inside it and `vscode` left to the extension host.
 *
 * Runs where the sessions are (`extensionKind: workspace`), so over SSH and in containers it
 * reads the remote machine's Claude Code folders. Everything that does not need the vscode
 * module lives in plain modules beside this one and is unit tested with fakes.
 */

import * as vscode from "vscode";
import { createNodeSessionReplayer, type SessionReplayer } from "@orbitrace/core/node";
import { appBundleDir, readAppIndex } from "./app-bundle.js";
import { COMMANDS, createCommandHandlers } from "./commands.js";
import { PanelManager } from "./panels.js";
import { createSessionCatalog, type CatalogEntry } from "./session-catalog.js";
import { describeSession } from "./session-labels.js";
import { SessionTreeProvider } from "./session-tree.js";

/** The Sessions view id, as in package.json `contributes.views`. */
export const SESSIONS_VIEW = "orbitrace.sessions";

/** URI schemes whose `fsPath` is a real path on the machine the extension runs on. */
const DISK_SCHEMES = new Set(["file", "vscode-remote"]);

/** File system paths of the open workspace folders on this machine. */
export function workspaceFolderPaths(
  folders: readonly { readonly uri: { readonly scheme: string; readonly fsPath: string } }[] = [],
): string[] {
  return folders.filter((folder) => DISK_SCHEMES.has(folder.uri.scheme)).map((f) => f.uri.fsPath);
}

export interface ActivateOptions {
  /** Session replayer. Default: `createNodeSessionReplayer()` for this process. For tests. */
  readonly replayer?: SessionReplayer;
}

export function activate(context: vscode.ExtensionContext, options: ActivateOptions = {}): void {
  const replayer = options.replayer ?? createNodeSessionReplayer();
  const catalog = createSessionCatalog(replayer);
  const workspacePaths = (): string[] => workspaceFolderPaths(vscode.workspace.workspaceFolders);

  const appDir = appBundleDir(context.extensionUri.fsPath);
  let indexHtml: string | undefined;
  const panels = new PanelManager({
    extensionUri: context.extensionUri,
    replayer,
    readIndexHtml: () => (indexHtml ??= readAppIndex(appDir)),
  });

  // Filled in once the view exists; the provider reports loads only after the view asks.
  const shown: { view?: vscode.TreeView<unknown> } = {};
  const tree = new SessionTreeProvider({
    catalog,
    workspacePaths,
    onLoaded: (message) => {
      // An empty message hides the line.
      if (shown.view !== undefined) shown.view.message = message ?? "";
    },
  });
  const view = vscode.window.createTreeView(SESSIONS_VIEW, { treeDataProvider: tree });
  shown.view = view;

  const handlers = createCommandHandlers({
    catalog,
    workspacePaths,
    open: (target) => {
      panels.open(target);
    },
    chooseSession: async (entries: readonly CatalogEntry[]) => {
      const now = Date.now();
      const items = entries.map((entry) => {
        const text = describeSession(entry.summary, now);
        return {
          label: text.label,
          description: entry.inWorkspace
            ? `${text.description} · this workspace`
            : text.description,
          entry,
        };
      });
      const chosen = await vscode.window.showQuickPick(items, {
        title: "Orbitrace: Visualise session",
        placeHolder: "Choose a session",
        matchOnDescription: true,
      });
      return chosen?.entry;
    },
    showInfo: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    showError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });

  context.subscriptions.push(
    panels,
    tree,
    view,
    view.onDidChangeVisibility((event) => {
      if (event.visible) tree.refresh();
    }),
    vscode.commands.registerCommand(COMMANDS.visualiseCurrent, () => handlers.visualiseCurrent()),
    vscode.commands.registerCommand(COMMANDS.visualiseSession, (argument?: unknown) =>
      handlers.visualiseSession(argument),
    ),
    vscode.commands.registerCommand(COMMANDS.openDemo, () => handlers.openDemo()),
    vscode.commands.registerCommand(COMMANDS.refreshSessions, () => tree.refresh()),
  );
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
