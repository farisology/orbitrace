import { HOST_META_NAME } from "@orbitrace/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  activate,
  deactivate,
  historyWorkerUrl,
  SESSIONS_VIEW,
  workspaceFolderPaths,
} from "../src/extension.js";
import { COMMANDS, COMMAND_MESSAGES } from "../src/commands.js";
import { HISTORY_BUTTONS, HISTORY_COMMANDS, unavailableMessage } from "../src/history-commands.js";
import { OUTPUT_CHANNEL, type ExtensionHistoryOptions } from "../src/history.js";
import type { HistoryCapability, HistoryIngestRequest } from "@orbitrace/core/node";
import { env as fakeEnv, fake, workspace as fakeWorkspace } from "./fakes/vscode.js";
import {
  demoReplay,
  fakeReplayer,
  fixtureReplayer,
  flush,
  makeRef,
  makeSummary,
  makeTempDir,
} from "./helpers.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INDEX = `<!doctype html><html><head><title>t</title><script type="module" src="./assets/a.js"></script></head><body></body></html>`;

/** A fake installed extension folder with an app page. */
function extensionDir(): string {
  const dir = makeTempDir();
  mkdirSync(join(dir, "dist", "app"), { recursive: true });
  writeFileSync(join(dir, "dist", "app", "index.html"), INDEX);
  return dir;
}

function context(dir: string): {
  subscriptions: { dispose(): unknown }[];
  extensionUri: vscode.Uri;
} {
  return { subscriptions: [], extensionUri: vscode.Uri.file(dir) };
}

beforeEach(() => {
  fake.reset();
});

describe("workspaceFolderPaths", () => {
  it("keeps folders on disk, local or remote, and drops virtual ones", () => {
    expect(
      workspaceFolderPaths([
        { uri: { scheme: "file", fsPath: "/workspace/kite" } },
        { uri: { scheme: "vscode-remote", fsPath: "/workspace/remote" } },
        { uri: { scheme: "vscode-vfs", fsPath: "/virtual" } },
      ]),
    ).toEqual(["/workspace/kite", "/workspace/remote"]);
    expect(workspaceFolderPaths()).toEqual([]);
  });
});

describe("activate", () => {
  it("registers the Sessions view and the commands, and cleans up on dispose", () => {
    const ctx = context(extensionDir());
    activate(ctx as unknown as vscode.ExtensionContext, { replayer: fakeReplayer([]) });
    expect(fake.treeViews.map((view) => view.id)).toEqual([SESSIONS_VIEW]);
    expect([...fake.commands.keys()].sort()).toEqual(Object.values(COMMANDS).sort());
    for (const item of ctx.subscriptions) item.dispose();
    expect(fake.commands.size).toBe(0);
    expect(fake.treeViews[0]?.disposed).toBe(true);
    expect(() => deactivate()).not.toThrow();
  });

  it("Visualise current session opens the workspace session and serves it to the app", async () => {
    const summary = makeSummary();
    const replayer = fakeReplayer([makeRef(summary, "-workspace-kite-workshop")]);
    fakeWorkspace.workspaceFolders = [
      { uri: vscode.Uri.file("/workspace/kite-workshop"), name: "kite-workshop", index: 0 },
    ];
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, { replayer });
    await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
    const panel = fake.panels[0];
    expect(panel?.title).toBe("Orbitrace: kite-workshop");
    expect(panel?.webview.html).toContain(`content="${summary.key}"`);
    panel?.webview.receive({ id: 1, method: "loadReplay", params: { key: summary.key } });
    await flush();
    expect(panel?.webview.posted[0]).toMatchObject({ kind: "result", id: 1 });
    expect(fake.infos).toEqual([]);
  });

  it("falls back to the demo when there are no sessions", async () => {
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([]),
    });
    await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
    expect(fake.panels[0]?.title).toBe("Orbitrace: demo");
    expect(fake.panels[0]?.webview.html).not.toContain(HOST_META_NAME);
    expect(fake.infos).toEqual([COMMAND_MESSAGES.noSessions]);
  });

  it("Visualise session... offers a quick pick marked with the workspace", async () => {
    const summary = makeSummary();
    fakeWorkspace.workspaceFolders = [
      { uri: vscode.Uri.file("/workspace/kite-workshop"), name: "kite-workshop", index: 0 },
    ];
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([makeRef(summary, "-workspace-kite-workshop")]),
    });
    fake.quickPick = (items) => items[0];
    await vscode.commands.executeCommand(COMMANDS.visualiseSession);
    const items = fake.quickPickCalls[0]?.items as { label: string; description: string }[];
    expect(items[0]?.label).toBe("kite-workshop");
    expect(items[0]?.description).toContain("this workspace");
    expect(fake.panels).toHaveLength(1);
  });

  it("refreshes the Sessions view on the command and when it becomes visible, and shows a listing error", async () => {
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([], { listError: new Error("x") }),
    });
    const view = fake.treeViews[0];
    const onChange = vi.fn();
    view?.treeDataProvider.onDidChangeTreeData?.(onChange);
    await vscode.commands.executeCommand(COMMANDS.refreshSessions);
    view?.setVisible(true);
    view?.setVisible(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    await view?.treeDataProvider.getChildren();
    expect(view?.message).toBe("The Claude Code session folders could not be read.");
  });

  it("reports a missing app instead of opening an empty tab", async () => {
    activate(context(makeTempDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([]),
    });
    await vscode.commands.executeCommand(COMMANDS.openDemo);
    expect(fake.panels).toHaveLength(0);
    expect(fake.errors[0]).toMatch(/web app is missing/);
  });

  it("works end to end with core's replayer over the synthetic fixtures", async () => {
    const { replayer } = fixtureReplayer();
    fakeWorkspace.workspaceFolders = [
      { uri: vscode.Uri.file("/workspace/kite-workshop"), name: "kite-workshop", index: 0 },
    ];
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, { replayer });
    const top = await fake.treeViews[0]?.treeDataProvider.getChildren();
    expect(top?.[0]).toMatchObject({ kind: "group", group: "workspace" });
    await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
    expect(fake.panels[0]?.title).toBe("Orbitrace: kite-workshop");
  });
});

const AVAILABLE: HistoryCapability = {
  available: true,
  engine: "node:sqlite",
  nodeVersion: "v24.0.0",
  sqliteVersion: "3.50.0",
  fts5: true,
};

/**
 * History settings for one test: new temporary home, config and data folders (the data folder is
 * not created), a capability stand-in and a stand-in worker that records each copy.
 */
function historyFor(capability: HistoryCapability = AVAILABLE) {
  const base = makeTempDir();
  const home = join(base, "home");
  const data = join(base, "data");
  mkdirSync(home);
  const copies: HistoryIngestRequest[] = [];
  const options: Partial<ExtensionHistoryOptions> = {
    env: { HOME: home, CLAUDE_CONFIG_DIR: join(base, "config"), ORBITRACE_DATA_DIR: data },
    homeDir: home,
    capability: async () => capability,
    workerUrl: "file:///srv/example/history-worker.js",
    listFileSessions: async () => [makeRef(makeSummary(), "-workspace-kite-workshop")],
    debounceMs: 1,
    runWorker: async (request) => {
      copies.push(request);
      return {
        sessions: request.sessions?.length ?? 0,
        sessionsSkipped: 0,
        files: 1,
        filesMissing: 0,
        filesReset: 0,
        linesRead: 2,
        linesAdded: 2,
        linesSkipped: 0,
        redactions: 0,
        durationMs: 1,
      };
    },
  };
  return { base, home, data, options, copies, settings: join(data, "settings.json") };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("historyWorkerUrl", () => {
  it("finds dist/history-worker.js beside the bundle, or null without it", () => {
    const dir = makeTempDir();
    expect(historyWorkerUrl(dir)).toBeNull();
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "history-worker.js"), "");
    expect(historyWorkerUrl(dir)?.protocol).toBe("file:");
    expect(historyWorkerUrl(dir)?.pathname.endsWith("/dist/history-worker.js")).toBe(true);
  });
});

describe("history in the extension (#211)", () => {
  it("registers the six history commands", () => {
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([]),
      history: historyFor().options,
    });
    for (const id of Object.values(HISTORY_COMMANDS)) expect(fake.commands.has(id)).toBe(true);
  });

  it("with recording off, activating, listing and the read-only commands create nothing", async () => {
    const h = historyFor();
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([makeRef(makeSummary(), "-workspace-kite-workshop")]),
      history: h.options,
    });
    await fake.treeViews[0]?.treeDataProvider.getChildren();
    await vscode.commands.executeCommand(HISTORY_COMMANDS.status);
    await vscode.commands.executeCommand(HISTORY_COMMANDS.showLocation);
    await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOff);
    await vscode.commands.executeCommand(HISTORY_COMMANDS.deleteAll);
    await settle();
    expect(h.copies).toEqual([]);
    expect(existsSync(h.data)).toBe(false);
    expect(existsSync(join(h.home, ".orbitrace"))).toBe(false);
    expect(fake.outputChannels).toEqual([]);
    await deactivate();
  });

  it("Turn on asks in a modal, writes the shared switch and copies every session at once", async () => {
    const h = historyFor();
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([]),
      history: h.options,
    });
    fake.answer = (call) => (call.options?.modal === true ? HISTORY_BUTTONS.turnOn : undefined);
    await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOn);
    await settle();
    const modal = fake.messageCalls.find((call) => call.options?.modal === true);
    expect(modal?.message).toBe("Turn history recording on?");
    expect(modal?.options?.detail).toContain("redaction is best effort");
    expect(modal?.items).toEqual([HISTORY_BUTTONS.turnOn]);
    expect(readFileSync(h.settings, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
    expect(h.copies).toHaveLength(1);
    expect(fake.outputChannels.map((channel) => channel.name)).toEqual([OUTPUT_CHANNEL]);
    expect(fake.outputChannels[0]?.lines).toEqual([
      "History: copied 2 new lines from 1 session in the background worker (1 ms).",
    ]);
    await deactivate();
  });

  it("in a remote window, the turn-on dialog says the store is on the remote machine", async () => {
    const h = historyFor();
    fakeEnv.remoteName = "ssh-remote";
    try {
      activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
        replayer: fakeReplayer([]),
        history: h.options,
      });
      // Declined, so nothing is written.
      await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOn);
      await settle();
      const modal = fake.messageCalls.find((call) => call.options?.modal === true);
      expect(modal?.options?.detail).toContain(
        "on the remote machine this window is connected to (ssh-remote), not on this computer",
      );
      expect(modal?.options?.detail).toContain("The copy stays on that machine");
      expect(existsSync(h.data)).toBe(false);
      await deactivate();
    } finally {
      fakeEnv.remoteName = undefined;
    }
  });

  it("when on, copies at activation and again when a session a tab follows changes, until deactivate", async () => {
    const h = historyFor();
    mkdirSync(h.data);
    writeFileSync(h.settings, '{"settings":1,"historyRecording":true}\n');
    const summary = makeSummary();
    const replayer = fakeReplayer([makeRef(summary, "-workspace-kite-workshop")]);
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer,
      history: h.options,
    });
    await settle();
    expect(h.copies).toHaveLength(1);
    await vscode.commands.executeCommand(COMMANDS.visualiseSession, summary.key);
    const panel = fake.panels[0];
    panel?.webview.receive({ id: 1, method: "subscribe", params: { key: summary.key } });
    await flush();
    replayer.follows[0]?.listener({ type: "replay", replay: demoReplay(), live: "idle" });
    await settle();
    expect(h.copies.map((copy) => copy.sessions?.map((ref) => ref.key))).toEqual([
      [summary.key],
      [summary.key],
    ]);
    await deactivate();
    replayer.follows[0]?.listener({ type: "replay", replay: demoReplay(), live: "idle" });
    await settle();
    expect(h.copies).toHaveLength(2);
  });

  it("where the store cannot run, every history command explains why and nothing else changes", async () => {
    const reason =
      "This Node.js (v20.18.1) has no node:sqlite module. History needs Node 22.13 or later.";
    const h = historyFor({
      available: false,
      engine: "node:sqlite",
      nodeVersion: "v20.18.1",
      reason,
    });
    mkdirSync(h.data);
    writeFileSync(h.settings, '{"settings":1,"historyRecording":true}\n');
    activate(context(extensionDir()) as unknown as vscode.ExtensionContext, {
      replayer: fakeReplayer([makeRef(makeSummary(), "-workspace-kite-workshop")]),
      history: h.options,
    });
    for (const id of Object.values(HISTORY_COMMANDS)) await vscode.commands.executeCommand(id);
    await settle();
    expect(fake.errors).toEqual(
      Object.values(HISTORY_COMMANDS).map(() => unavailableMessage(reason)),
    );
    expect(fake.messageCalls).toEqual([]);
    expect(h.copies).toEqual([]);
    expect(readFileSync(h.settings, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
    // The rest of the extension works as before.
    await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
    expect(fake.panels).toHaveLength(1);
    await deactivate();
  });
});
