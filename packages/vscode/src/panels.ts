/**
 * Editor tabs (vscode glue). One `WebviewPanel` per session, revealed when it is already
 * open, plus one for the demo. A session tab runs a message host that answers the app through
 * the shared session replayer; closing the tab disposes the host and every subscription it
 * holds. The demo tab has no message host: its page carries no host tags, so the app serves
 * its bundled demo and never posts.
 *
 * A session tab's message host can save an exported replay (#168) through the editor's save
 * dialog (`save-replay.ts`). The demo tab cannot, so the app shows no Export button there.
 */

import * as vscode from "vscode";
import { APP_BUNDLE_SEGMENTS } from "./app-bundle.js";
import type { PanelTarget } from "./commands.js";
import {
  createMessageHost,
  type MessageHost,
  type MessageHostOptions,
  type MessageHostReplayer,
} from "./message-host.js";
import { saveReplayWithDialog } from "./save-replay.js";
import { panelTitle } from "./session-labels.js";
import { buildWebviewHtml } from "./webview-html.js";

/** The webview panel type. */
export const PANEL_VIEW_TYPE = "orbitrace.visualizer";

export interface PanelManagerOptions {
  readonly extensionUri: vscode.Uri;
  readonly replayer: MessageHostReplayer;
  /** Saves an exported replay (#168). Default: the editor's save dialog (`saveReplayWithDialog`). */
  readonly saveReplay?: MessageHostOptions["saveReplay"];
  /** The app's index.html. May throw when the app is missing. */
  readIndexHtml(): string;
}

interface OpenPanel {
  readonly panel: vscode.WebviewPanel;
  readonly host: MessageHost | null;
}

/** The id one target's tab is kept under. */
export function panelId(target: PanelTarget): string {
  return target.kind === "demo" ? "demo" : `session:${target.key}`;
}

export class PanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, OpenPanel>();

  constructor(private readonly options: PanelManagerOptions) {}

  /** Number of open tabs. */
  get size(): number {
    return this.panels.size;
  }

  /** Open the tab for a target, or reveal it when it is already open. Throws when the app is missing. */
  open(target: PanelTarget): vscode.WebviewPanel {
    const id = panelId(target);
    const existing = this.panels.get(id);
    if (existing !== undefined) {
      existing.panel.reveal();
      return existing.panel;
    }
    // Read the page first, so a missing app throws before a tab appears.
    const indexHtml = this.options.readIndexHtml();
    const appUri = vscode.Uri.joinPath(this.options.extensionUri, ...APP_BUNDLE_SEGMENTS);
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      panelTitle(target.kind === "demo" ? null : target.summary),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: false,
        localResourceRoots: [appUri],
        // Keeps the app and its subscriptions alive while the tab is in the background.
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.options.extensionUri, "media", "activity-bar.svg");

    let host: MessageHost | null = null;
    let listener: vscode.Disposable | null = null;
    try {
      panel.webview.html = buildWebviewHtml(indexHtml, {
        cspSource: panel.webview.cspSource,
        baseUri: panel.webview.asWebviewUri(appUri).toString(),
        mode: target.kind === "demo" ? "demo" : "editor",
        ...(target.kind === "session" ? { sessionKey: target.key } : {}),
      });
      if (target.kind === "session") {
        const created = createMessageHost({
          replayer: this.options.replayer,
          post: (message) => panel.webview.postMessage(message),
          saveReplay: this.options.saveReplay ?? ((data) => saveReplayWithDialog(data)),
        });
        host = created;
        listener = panel.webview.onDidReceiveMessage((message: unknown) => {
          void created.handle(message);
        });
      }
    } catch (error) {
      panel.dispose();
      throw error;
    }

    this.panels.set(id, { panel, host });
    panel.onDidDispose(() => {
      host?.dispose();
      listener?.dispose();
      if (this.panels.get(id)?.panel === panel) this.panels.delete(id);
    });
    return panel;
  }

  /** Close every tab. */
  dispose(): void {
    for (const { panel } of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }
}
