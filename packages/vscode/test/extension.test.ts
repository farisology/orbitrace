import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { activate, deactivate, SESSIONS_VIEW, workspaceFolderPaths } from "../src/extension.js";
import { COMMANDS, COMMAND_MESSAGES } from "../src/commands.js";
import { fake, workspace as fakeWorkspace } from "./fakes/vscode.js";
import {
  fakeReplayer,
  fixtureReplayer,
  flush,
  makeRef,
  makeSummary,
  makeTempDir,
} from "./helpers.js";
import { mkdirSync, writeFileSync } from "node:fs";
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
    expect(fake.panels[0]?.webview.html).not.toContain("orbitrace-host");
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
