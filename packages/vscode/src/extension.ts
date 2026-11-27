/**
 * Extension entry (vscode glue). Bundled with esbuild into one CommonJS file,
 * dist/extension.js, with @orbitrace/core inside it and `vscode` left to the extension host.
 * Core's history ingest worker is bundled as a second file beside it, dist/history-worker.js
 * (#211): a worker thread starts from a file, so it is never inlined.
 *
 * Runs where the sessions are (`extensionKind: workspace`), so over SSH and in containers it
 * reads the remote machine's Claude Code folders. Everything that does not need the vscode
 * module lives in plain modules beside this one and is unit tested with fakes.
 *
 * History (#211): the switch is core's settings file, shared with the `orbitrace` command. When
 * it is on, the extension copies sessions into the history store through the worker at activation
 * and, debounced, when a session a tab follows changes, and stops on deactivate. Sessions kept only
 * in the store are listed and opened like any other. With recording off nothing is created on
 * disk. See `history.ts` and `history-commands.ts`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { listSessions, resolveSources, type SourceAdapter } from "@orbitrace/core";
import {
  claudeCodeAdapter,
  createNodeSessionReplayer,
  nodeResolveContext,
  recordingSessionReplayer,
  type SessionReplayer,
} from "@orbitrace/core/node";
import { appBundleDir, readAppIndex } from "./app-bundle.js";
import { COMMANDS, createCommandHandlers } from "./commands.js";
import {
  createExtensionHistory,
  HISTORY_WORKER_FILE,
  ingestLogLine,
  OUTPUT_CHANNEL,
  type ExtensionHistory,
  type ExtensionHistoryOptions,
} from "./history.js";
import { createHistoryCommandHandlers, HISTORY_COMMANDS } from "./history-commands.js";
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

/** The worker file beside the bundle in an extension folder, or null when it is not there. */
export function historyWorkerUrl(extensionDir: string): URL | null {
  const file = join(extensionDir, "dist", HISTORY_WORKER_FILE);
  return existsSync(file) ? pathToFileURL(file) : null;
}

export interface ActivateOptions {
  /**
   * Session replayer. Default: core's replayer over the Claude Code folders and, when there is
   * one, the history store. For tests.
   */
  readonly replayer?: SessionReplayer;
  /** History settings for tests: the capability check, the worker, the copy and the clock. */
  readonly history?: Partial<ExtensionHistoryOptions>;
}

/** The history of the active extension, so `deactivate` can stop its recording. */
let active: ExtensionHistory | null = null;

export function activate(context: vscode.ExtensionContext, options: ActivateOptions = {}): void {
  const fileAdapters: readonly SourceAdapter[] = [claudeCodeAdapter];
  const fileRoots = () => resolveSources(nodeResolveContext(), fileAdapters);
  // Filled in once the replayer exists: the recorder looks sessions up through it.
  const lookup: { replayer?: SessionReplayer } = {};
  let output: vscode.OutputChannel | undefined;
  const log = (line: string): void => {
    output ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL);
    output.appendLine(line);
  };

  const history = createExtensionHistory({
    workerUrl: historyWorkerUrl(context.extensionUri.fsPath),
    listFileSessions: async () => listSessions(await fileRoots(), fileAdapters),
    findSession: async (key) => {
      try {
        return (await lookup.replayer?.find(key)) ?? null;
      } catch {
        return null;
      }
    },
    onProblem: (message, problem) => {
      log(message);
      // A store that cannot be used is worth a notification; the rest only goes to the log.
      if (problem === null || problem.kind === "fatal") {
        void vscode.window.showWarningMessage(message);
      }
    },
    onIngested: (result) => log(ingestLogLine(result)),
    ...options.history,
  });
  active = history;

  const adapters = history.adapters(fileAdapters);
  const replayer =
    options.replayer ??
    createNodeSessionReplayer({
      adapters,
      // The history root is looked for on every listing: recording may create the store later.
      roots: async () => {
        const roots = await resolveSources(nodeResolveContext(), adapters);
        const root = await history.root();
        return root === null ? roots : [...roots, root];
      },
    });
  lookup.replayer = replayer;
  // Each replay a tab follows tells the history to copy that session again (when recording).
  const served = recordingSessionReplayer(replayer, history);
  const catalog = createSessionCatalog(replayer);
  const workspacePaths = (): string[] => workspaceFolderPaths(vscode.workspace.workspaceFolders);

  const appDir = appBundleDir(context.extensionUri.fsPath);
  let indexHtml: string | undefined;
  const panels = new PanelManager({
    extensionUri: context.extensionUri,
    replayer: served,
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
        const text = describeSession(entry.summary, now, {
          fromHistory: entry.fromHistory === true,
        });
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

  const historyHandlers = createHistoryCommandHandlers({
    history,
    ask: async (question) =>
      (await vscode.window.showWarningMessage(
        question.message,
        { modal: true, detail: question.detail },
        question.confirm,
      )) === question.confirm,
    pickSession: async (items) =>
      vscode.window.showQuickPick(items, {
        title: "Orbitrace: Delete a session from history",
        placeHolder: "Choose the stored session to delete",
        matchOnDescription: true,
      }),
    showInfo: async (message, ...buttons) => {
      // A notification without buttons is not waited for: it resolves only when it is closed.
      if (buttons.length === 0) {
        void vscode.window.showInformationMessage(message);
        return undefined;
      }
      return vscode.window.showInformationMessage(message, ...buttons);
    },
    showWarning: (message) => {
      void vscode.window.showWarningMessage(message);
    },
    showError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
    copyText: async (text) => vscode.env.clipboard.writeText(text),
    refreshSessions: () => tree.refresh(),
    // Over Remote SSH, WSL or a dev container the store is on the remote machine; say so.
    ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
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
    vscode.commands.registerCommand(HISTORY_COMMANDS.turnOn, () => historyHandlers.turnOn()),
    vscode.commands.registerCommand(HISTORY_COMMANDS.turnOff, () => historyHandlers.turnOff()),
    vscode.commands.registerCommand(HISTORY_COMMANDS.status, () => historyHandlers.status()),
    vscode.commands.registerCommand(HISTORY_COMMANDS.deleteSession, () =>
      historyHandlers.deleteSession(),
    ),
    vscode.commands.registerCommand(HISTORY_COMMANDS.deleteAll, () => historyHandlers.deleteAll()),
    vscode.commands.registerCommand(HISTORY_COMMANDS.showLocation, () =>
      historyHandlers.showLocation(),
    ),
    {
      dispose: () => {
        void history.stop();
        output?.dispose();
      },
    },
  );

  // When recording is on, copy every session now, in the worker. With it off this reads the
  // settings file and nothing else.
  void history.sync();
}

/** Stops history recording (a running copy is terminated; what it committed stays). */
export async function deactivate(): Promise<void> {
  const history = active;
  active = null;
  await history?.stop();
}
