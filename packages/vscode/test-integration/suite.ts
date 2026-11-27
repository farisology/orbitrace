/**
 * The integration suite (ticket #102; the history store steps, `history-steps.ts`, ticket #196;
 * the extension's own history commands, `buildEditorHistorySteps` below, ticket #211).
 * Runs inside a real VS Code extension host, launched by
 * `run.ts` with the built extension from this package, a temporary workspace, profile and
 * extensions folder, and `CLAUDE_CONFIG_DIR` / `HOME` pointing at a synthetic config tree
 * (`sandbox.ts`).
 *
 * What it can see: everything the extension host controls, through the spies in `spies.ts`
 * (the page HTML a panel was given, the messages the webview sent, the messages the extension
 * posted, the Sessions view's provider) and the public editor API (commands, tabs, extension
 * state). What it cannot see: the webview's DOM and pixels. The best proof that the app
 * bundle runs under the real policy is that the app itself sends its first requests, which the
 * suite waits for.
 */

import { appendFileSync, existsSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  EDITOR_HOST_META_VALUE,
  parseTransportMessage,
  validateReplayModel,
  type SessionSummary,
} from "@orbitrace/core";
import {
  HISTORY_DEFAULT_FOLDER,
  HISTORY_LOCK_FILE,
  historyCapability,
  historySettingsFile,
  openHistoryStore,
  readHistorySettings,
  resolveHistoryLocation,
  withoutSqliteWarning,
  type HistoryCapability,
} from "@orbitrace/core/node";
import { APP_BUNDLE_SEGMENTS } from "../src/app-bundle.js";
import { COMMANDS } from "../src/commands.js";
import { HISTORY_WORKER_FILE, OUTPUT_CHANNEL } from "../src/history.js";
import {
  HISTORY_BUTTONS,
  HISTORY_COMMANDS,
  HISTORY_MESSAGES,
  unavailableMessage,
  type StoredSessionItem,
} from "../src/history-commands.js";
import { PANEL_VIEW_TYPE } from "../src/panels.js";
import { GROUP_TITLES, type SessionTreeNode } from "../src/session-catalog.js";
import { panelTitle } from "../src/session-labels.js";
import { HISTORY_SESSION_CONTEXT, LIST_FAILED_MESSAGE } from "../src/session-tree.js";
import { buildHistorySteps, countTranscripts } from "./history-steps.js";
import { pathInsideBase, policyProblems, readPage } from "./html-checks.js";
import { installPromptSpies, type PromptSpies, type PromptWindowLike } from "./prompt-spies.js";
import {
  appendSuiteLog,
  readSandbox,
  SANDBOX_ENV,
  writeSuiteResult,
  type SandboxDescription,
} from "./sandbox-description.js";
import {
  installApiSpies,
  liveMessages,
  repliesTo,
  webviewRequests,
  type ApiSpies,
  type PanelRecord,
  type TransportLiveMessage,
  type TransportReply,
  type TreeRecord,
  type WindowLike,
} from "./spies.js";
import {
  delay,
  errorMessage,
  mergeReports,
  runSteps,
  summarizeReport,
  waitFor,
  withTimeout,
  type Step,
  type StepReport,
} from "./steps.js";

/** `name` in this package's package.json. */
const EXTENSION_NAME = "orbitrace-vscode";

/** This package's folder: the bundle runs from `test-integration/dist/`. */
const PACKAGE_DIR = resolve(__dirname, "..", "..");

/** How long the app in a webview may take to send its first request. */
const APP_START_TIMEOUT_MS = 30_000;

/** Request ids the suite uses for messages it hands to the host itself. */
const IDS = {
  list: 90_001,
  load: 90_002,
  unknownMethod: 90_003,
  unknownKey: 90_004,
  subscribe: 90_010,
  afterClose: 90_020,
  historyLoad: 90_030,
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sameMembers(actual: readonly string[], expected: readonly string[], what: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((value, index) => value !== e[index])) {
    throw new Error(`${what}: expected ${e.length} entries, got ${a.length} that differ`);
  }
}

/** Number of `fs.watch` handles open in this process (the extension host). */
function openFolderWatchers(): number {
  return process.getActiveResourcesInfo().filter((name) => name === "FSEventWrap").length;
}

/** The single reply to request `id`, once it is posted. */
async function replyTo(
  record: PanelRecord,
  id: number,
  timeoutMs = 10_000,
): Promise<TransportReply> {
  const replies = await waitFor(
    () => {
      const found = repliesTo(record, id);
      return found.length > 0 ? found : undefined;
    },
    { label: `the reply to request ${id}`, timeoutMs },
  );
  assertEqual(replies.length, 1, `replies to request ${id}`);
  const [reply] = replies;
  assert(reply !== undefined, `no reply to request ${id}`);
  return reply;
}

/** The `result` of a reply; fails, with the error's code and message, when it is an error. */
function resultOf(reply: TransportReply, what: string): unknown {
  if (reply.kind === "error") {
    throw new Error(
      `${what}: expected a result, got error ${reply.error.code}: ${reply.error.message}`,
    );
  }
  return reply.result;
}

/** The error code of a reply; fails when it is a result. */
function errorCodeOf(reply: TransportReply, what: string): string {
  assert(reply.kind === "error", `${what}: expected an error, got a result`);
  return reply.error.code;
}

/** The replay a live message carries; fails when its update is not a `replay` update. */
function liveReplayOf(message: TransportLiveMessage, what: string): unknown {
  const { update } = message;
  assert(update.type === "replay", `${what}: expected a replay update, got ${update.type}`);
  return update.replay;
}

function summariesOf(reply: TransportReply, what: string): SessionSummary[] {
  const result = resultOf(reply, what);
  assert(Array.isArray(result), `${what} result is not a list`);
  return result as SessionSummary[];
}

/** Append one synthetic line of a type the parser does not know, so the transcript changes. */
function touchTranscript(path: string, n: number): void {
  appendFileSync(path, `${JSON.stringify({ type: "orbitrace-integration-probe", n })}\n`, "utf8");
}

/** The editor tab of a panel. */
function tabOf(panel: vscode.WebviewPanel): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.endsWith(PANEL_VIEW_TYPE) &&
        tab.label === panel.title,
    );
}

/** The open tabs, for failure messages: label and kind of input. */
function describeTabs(): string {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  if (tabs.length === 0) return "none";
  return tabs
    .map((tab) => {
      const input = tab.input;
      const kind =
        input instanceof vscode.TabInputWebview
          ? `webview ${input.viewType}`
          : input instanceof vscode.TabInputText
            ? "text"
            : "other";
      return `"${tab.label}" (${kind})`;
    })
    .join(", ");
}

/** State shared by the steps. */
interface Context {
  readonly sandbox: SandboxDescription;
  readonly appDir: string;
  /** Writes one report line (to the sandbox log and the extension host console). */
  readonly log: (line: string) => void;
  extension?: vscode.Extension<unknown>;
  spies?: ApiSpies;
  viewId?: string;
  sessionPanel?: PanelRecord;
  liveLatencyMs?: number;
  /** `fs.watch` handles open in the extension host before any panel was opened. */
  watchersBaseline?: number;
  projectsHidden?: boolean;
  /** The dialogs of the history commands, answered by the suite (#211). */
  prompts?: PromptSpies;
  /** What `historyCapability()` reports in this extension host. */
  historyCapability?: HistoryCapability;
  /** The session whose transcript the history steps delete. */
  historyVictim?: string;
}

function spiesOf(context: Context): ApiSpies {
  assert(context.spies !== undefined, "the API spies are not installed");
  return context.spies;
}

function treeOf(context: Context): TreeRecord {
  const tree = spiesOf(context).trees.find((record) => record.viewId === context.viewId);
  assert(
    tree !== undefined,
    "the extension created no Sessions tree view that the suite could see. The extension host may no longer share one API object per extension folder (see spies.ts).",
  );
  return tree;
}

function sessionPanelOf(context: Context): PanelRecord {
  assert(context.sessionPanel !== undefined, "no session panel was opened");
  return context.sessionPanel;
}

/** Wait for a panel created after `count` panels existed. */
async function nextPanel(context: Context, count: number): Promise<PanelRecord> {
  return waitFor(() => spiesOf(context).panels[count], {
    label: "a new webview panel",
    timeoutMs: 10_000,
  });
}

/** Check a panel's page: policy, `<base>`, resources mapped back to files of the app folder. */
function checkPageCommon(record: PanelRecord, appDir: string): ReturnType<typeof readPage> {
  const panel = record.panel as unknown as vscode.WebviewPanel;
  const html = panel.webview.html;
  const page = readPage(html);
  assertEqual(page.policies.length, 1, "Content-Security-Policy meta tags");
  const problems = policyProblems(page.policies[0] ?? "", panel.webview.cspSource);
  assert(problems.length === 0, `policy problems: ${problems.join("; ")}`);

  assertEqual(page.bases.length, 1, "<base> elements");
  const base = page.bases[0] ?? "";
  const expectedBase = `${panel.webview.asWebviewUri(vscode.Uri.file(appDir)).toString()}/`;
  assertEqual(base, expectedBase, "<base> href");
  if (process.platform !== "win32") {
    // The webview resource URI keeps the file path as its path.
    const basePath = decodeURIComponent(new URL(base).pathname).replace(/\/$/, "");
    assertEqual(basePath, appDir, "path of the <base> href");
  }

  assert(page.resources.length > 0, "the page loads no resources");
  assert(
    page.resources.some((ref) => /\.js$/.test(ref)),
    "the page loads no script",
  );
  for (const ref of page.resources) {
    const inside = pathInsideBase(ref, base);
    assert(inside !== null, `resource ${ref} resolves outside the app folder`);
    const file = join(appDir, ...inside.split("/"));
    assert(existsSync(file), `resource ${ref} has no file in the app folder`);
  }
  return page;
}

function buildSteps(context: Context): Step[] {
  const { sandbox } = context;
  const ws = sandbox.workspaceSession;
  const allKeys = [ws.key, ...sandbox.otherSessions.map((session) => session.key)];

  return [
    {
      name: "the editor runs in the sandbox, not in the real profile",
      run() {
        assertEqual(process.env.CLAUDE_CONFIG_DIR, sandbox.configDir, "CLAUDE_CONFIG_DIR");
        assertEqual(homedir(), sandbox.homeDir, "home folder");
        const folders = vscode.workspace.workspaceFolders ?? [];
        assertEqual(folders.length, 1, "workspace folders");
        const folder = folders[0];
        assert(folder !== undefined, "no workspace folder");
        assertEqual(realpathSync(folder.uri.fsPath), sandbox.workspaceDir, "workspace folder");
        assert(existsSync(join(context.appDir, "index.html")), "dist/app/index.html is missing");
      },
    },
    {
      name: "the extension is loaded from this package and is not active before it is needed",
      run() {
        const extension = vscode.extensions.all.find(
          (candidate) => (candidate.packageJSON as { name?: unknown }).name === EXTENSION_NAME,
        );
        assert(extension !== undefined, "the extension is not loaded");
        assertEqual(
          realpathSync(extension.extensionPath),
          realpathSync(PACKAGE_DIR),
          "extension folder",
        );
        assert(!extension.isActive, "the extension was already active before any of its events");
        const views = (
          extension.packageJSON as { contributes?: { views?: Record<string, { id: string }[]> } }
        ).contributes?.views?.orbitrace;
        const viewId = views?.[0]?.id;
        assert(viewId !== undefined, "the manifest declares no Sessions view");
        context.viewId = viewId;
        context.extension = extension;
        context.spies = installApiSpies(vscode.window as unknown as WindowLike);
      },
    },
    {
      name: "opening the Sessions view activates the extension",
      async run() {
        const extension = context.extension;
        assert(extension !== undefined, "no extension");
        await vscode.commands.executeCommand(`${context.viewId}.focus`);
        await waitFor(() => (extension.isActive ? true : undefined), {
          label: "the extension to activate",
          timeoutMs: 15_000,
        });
        await extension.activate();
        treeOf(context);
      },
    },
    {
      name: "its commands are registered",
      async run() {
        const registered = new Set(await vscode.commands.getCommands(true));
        for (const command of Object.values(COMMANDS)) {
          assert(registered.has(command), `command ${command} is not registered`);
        }
        const declared = (
          context.extension?.packageJSON as { contributes?: { commands?: { command: string }[] } }
        ).contributes?.commands?.map((entry) => entry.command);
        sameMembers(declared ?? [], Object.values(COMMANDS), "commands in the manifest");
      },
    },
    {
      name: "the Sessions view lists the synthetic sessions, the workspace's own first",
      async run() {
        const tree = treeOf(context);
        const load = await waitFor(() => tree.loads.find((entry) => entry.nodes.length > 0), {
          label: "the Sessions view to list sessions",
          timeoutMs: 15_000,
        });
        const view = tree.view as vscode.TreeView<unknown>;
        assert(view.visible, "the Sessions view is not visible");
        assert(view.message !== LIST_FAILED_MESSAGE, "the Sessions view reports a listing failure");

        const nodes = load.nodes as SessionTreeNode[];
        assertEqual(nodes.length, 2, "top-level groups");
        const [first, second] = nodes;
        assert(first?.kind === "group" && second?.kind === "group", "top level is not two groups");
        const firstItem = tree.provider.getTreeItem(first) as vscode.TreeItem;
        const secondItem = tree.provider.getTreeItem(second) as vscode.TreeItem;
        assertEqual(firstItem.label, GROUP_TITLES.workspace, "first group");
        assertEqual(secondItem.label, GROUP_TITLES.other, "second group");

        const children = async (node: SessionTreeNode): Promise<SessionTreeNode[]> =>
          (await tree.provider.getChildren(node)) as SessionTreeNode[];
        const keysOf = (rows: SessionTreeNode[]): string[] =>
          rows.map((row) => (row.kind === "session" ? row.entry.summary.key : ""));
        const inside = await children(first);
        const outside = await children(second);
        assertEqual(keysOf(inside).join(","), ws.key, "the workspace group's session");
        sameMembers(
          keysOf(outside),
          sandbox.otherSessions.map((session) => session.key),
          "the other projects group",
        );
        const row = inside[0];
        assert(row !== undefined, "no workspace row");
        const rowItem = tree.provider.getTreeItem(row) as vscode.TreeItem;
        assertEqual(rowItem.label, ws.projectLabel, "workspace row label");
        assertEqual(rowItem.command?.command, COMMANDS.visualiseSession, "workspace row command");
      },
    },
    {
      name: "Visualise current session opens a webview panel for the workspace session",
      async run() {
        const before = spiesOf(context).panels.length;
        context.watchersBaseline = openFolderWatchers();
        await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
        const record = await nextPanel(context, before);
        context.sessionPanel = record;
        assert(record.viewType === PANEL_VIEW_TYPE, `panel view type ${record.viewType}`);
        assertEqual(
          record.panel.title,
          panelTitle({ projectLabel: ws.projectLabel }),
          "panel title",
        );
        assertEqual(record.handlerCount, 1, "message handlers on the panel");
        // The tab appears a moment after the panel is created.
        await waitFor(() => tabOf(record.panel as unknown as vscode.WebviewPanel), {
          label: `a tab for the panel (tabs now: ${describeTabs()})`,
          timeoutMs: 5_000,
        }).catch(() => {
          throw new Error(`no tab for the panel; tabs: ${describeTabs()}`);
        });
      },
    },
    {
      name: "the panel's page carries the policy, both host meta tags and resources that exist",
      run() {
        const page = checkPageCommon(sessionPanelOf(context), context.appDir);
        assertEqual(page.hostMeta.join(","), EDITOR_HOST_META_VALUE, "orbitrace-host meta");
        assertEqual(page.sessionMeta.join(","), ws.key, "orbitrace-session meta");
      },
    },
    {
      name: "the app in the panel starts under that policy and the host answers its requests",
      timeoutMs: APP_START_TIMEOUT_MS + 15_000,
      async run() {
        const record = sessionPanelOf(context);
        const request = await waitFor(() => webviewRequests(record, "listSessions")[0], {
          label: "the app's first listSessions request",
          timeoutMs: APP_START_TIMEOUT_MS,
        });
        const listed = summariesOf(await replyTo(record, request.id), "the app's listSessions");
        sameMembers(
          listed.map((summary) => summary.key),
          allKeys,
          "sessions listed for the app",
        );
        const open = await waitFor(
          () =>
            [
              ...webviewRequests(record, "loadReplay"),
              ...webviewRequests(record, "subscribe"),
            ].find((entry) => entry.params.key === ws.key),
          { label: "the app to open the preselected session", timeoutMs: 15_000 },
        );
        const result = resultOf(await replyTo(record, open.id), `the app's ${open.method}`);
        if (open.method === "loadReplay") {
          assert(validateReplayModel(result), "the replay sent to the app is not a valid replay");
        } else {
          const live = await waitFor(() => liveMessages(record, open.id)[0], {
            label: "the first live update for the app",
            timeoutMs: 10_000,
          });
          const replay = liveReplayOf(live, "the first live update for the app");
          assert(validateReplayModel(replay), "the live replay is not a valid replay");
        }
        context.log(`            the app sent: listSessions, ${open.method}`);
      },
    },
    {
      name: "the message host answers listSessions and loadReplay handed to it directly",
      async run() {
        const record = sessionPanelOf(context);
        record.inject({ id: IDS.list, method: "listSessions", params: {} });
        const listed = summariesOf(await replyTo(record, IDS.list), "listSessions");
        sameMembers(
          listed.map((summary) => summary.key),
          allKeys,
          "listed sessions",
        );
        // The replayer lists newest first; the workspace session is the oldest.
        assertEqual(listed[listed.length - 1]?.key, ws.key, "oldest listed session");

        record.inject({ id: IDS.load, method: "loadReplay", params: { key: ws.key } });
        const loaded = resultOf(await replyTo(record, IDS.load), "loadReplay");
        assert(validateReplayModel(loaded), "loadReplay did not return a valid replay");

        record.inject({ id: IDS.unknownMethod, method: "readFile", params: {} });
        const unknown = await replyTo(record, IDS.unknownMethod);
        assertEqual(
          errorCodeOf(unknown, "unknown method"),
          "unsupported",
          "unknown method error code",
        );

        record.inject({
          id: IDS.unknownKey,
          method: "loadReplay",
          params: { key: "claude-code:00000000000000000000000000000000" },
        });
        const missing = await replyTo(record, IDS.unknownKey);
        assertEqual(errorCodeOf(missing, "unknown key"), "not-found", "unknown key error code");
      },
    },
    {
      name: "everything posted to the webview is a valid message and carries no sandbox path",
      run() {
        const record = sessionPanelOf(context);
        assert(record.posted.length > 0, "nothing was posted");
        for (const entry of record.posted) {
          assert(
            parseTransportMessage(entry.message) !== null,
            `a posted message is not a valid TransportMessage: ${JSON.stringify(entry.message).slice(0, 200)}`,
          );
        }
        for (const entry of record.posted) {
          const text = JSON.stringify(entry.message);
          assert(!text.includes(sandbox.root), "a posted message holds a sandbox path");
          assert(
            !text.includes("/projects/") && !text.includes("\\projects\\"),
            "a posted message holds a projects path",
          );
        }
      },
    },
    {
      name: "a subscription from the panel receives live updates when the transcript changes",
      async run() {
        const record = sessionPanelOf(context);
        record.inject({ id: IDS.subscribe, method: "subscribe", params: { key: ws.key } });
        resultOf(await replyTo(record, IDS.subscribe), "subscribe");
        await waitFor(() => liveMessages(record, IDS.subscribe)[0], {
          label: "the first live update",
          timeoutMs: 10_000,
        });
        const started = Date.now();
        touchTranscript(ws.transcript, 1);
        const second = await waitFor(() => liveMessages(record, IDS.subscribe)[1], {
          label: "a live update after the transcript changed",
          timeoutMs: 15_000,
        });
        context.liveLatencyMs = Date.now() - started;
        liveReplayOf(second, "the live update after the change");
        context.log(`            live update ${context.liveLatencyMs} ms after the change`);
      },
    },
    {
      name: "closing the panel disposes its subscriptions",
      async run() {
        const record = sessionPanelOf(context);
        const panel = record.panel as unknown as vscode.WebviewPanel;
        const watchersOpen = openFolderWatchers();
        const tab = tabOf(panel);
        assert(tab !== undefined, "no tab for the session panel");
        await vscode.window.tabGroups.close(tab);
        await waitFor(() => (record.disposed ? true : undefined), {
          label: "the panel to be disposed",
          timeoutMs: 10_000,
        });
        assertEqual(record.handlerCount, 0, "message handlers left on the closed panel");

        const postedAtClose = record.posted.length;
        touchTranscript(ws.transcript, 2);
        record.inject({ id: IDS.afterClose, method: "listSessions", params: {} });
        // Several times as long as the live update took while the panel was open.
        await delay(Math.max(2_000, 3 * (context.liveLatencyMs ?? 1_000)));
        assertEqual(record.posted.length, postedAtClose, "messages posted after the panel closed");
        assert(
          record.posted.every((entry) => !entry.afterDispose),
          "the extension tried to post to a disposed panel",
        );

        // The subscriptions of the app and of the suite each followed the session with
        // `fs.watch`; once the panel is gone, the extension host must be back to the handles it
        // had before the panel was opened.
        const before = context.watchersBaseline ?? 0;
        if (watchersOpen > before) {
          await waitFor(() => (openFolderWatchers() <= before ? true : undefined), {
            label: `folder watchers to close (${watchersOpen} open, ${before} before the panel)`,
            timeoutMs: 5_000,
          });
          context.log(
            `            folder watchers: ${before} before the panel, ${watchersOpen} open, ${openFolderWatchers()} after closing it`,
          );
        } else {
          context.log(
            "            folder watchers: none seen for the subscriptions (polling); not checked",
          );
        }
      },
    },
    {
      name: "with no sessions on the machine the Sessions view is empty",
      async run() {
        renameSync(join(sandbox.configDir, "projects"), join(sandbox.configDir, "projects-hidden"));
        context.projectsHidden = true;
        const tree = treeOf(context);
        const loadsBefore = tree.loads.length;
        await vscode.commands.executeCommand(COMMANDS.refreshSessions);
        const load = await waitFor(() => tree.loads[loadsBefore], {
          label: "the Sessions view to list again",
          timeoutMs: 10_000,
        });
        assertEqual(load.nodes.length, 0, "rows in the Sessions view");
      },
    },
    {
      name: "Open demo opens the demo tab, whose page has the policy and no host tags",
      async run() {
        const before = spiesOf(context).panels.length;
        await vscode.commands.executeCommand(COMMANDS.openDemo);
        const record = await nextPanel(context, before);
        assertEqual(record.panel.title, panelTitle(null), "demo panel title");
        const page = checkPageCommon(record, context.appDir);
        assertEqual(page.hostMeta.length, 0, "orbitrace-host meta on the demo page");
        assertEqual(page.sessionMeta.length, 0, "orbitrace-session meta on the demo page");
        assertEqual(record.handlerCount, 0, "message handlers on the demo panel");
      },
    },
    {
      name: "Visualise current session with no sessions brings the demo tab to the front",
      async run() {
        const before = spiesOf(context).panels.length;
        // Put another editor in front first, so the demo tab has to be revealed.
        await vscode.window.showTextDocument(
          vscode.Uri.file(join(sandbox.workspaceDir, "README.md")),
        );
        await vscode.commands.executeCommand(COMMANDS.visualiseCurrent);
        await waitFor(
          () =>
            vscode.window.tabGroups.activeTabGroup.activeTab?.label === panelTitle(null)
              ? true
              : undefined,
          { label: "the demo tab to be in front", timeoutMs: 10_000 },
        );
        assertEqual(spiesOf(context).panels.length, before, "panels created");
      },
    },
  ];
}

function promptsOf(context: Context): PromptSpies {
  assert(context.prompts !== undefined, "the dialog spies are not installed");
  return context.prompts;
}

/** The history steps that need the store run only where `historyCapability()` says available. */
function historyUnavailable(context: Context): string | undefined {
  const capability = context.historyCapability;
  if (capability === undefined) return "the capability was not checked";
  return capability.available ? undefined : capability.reason;
}

/** The settings file of the sandbox's data folder, as core reads it. */
function sandboxSwitch(): ReturnType<typeof readHistorySettings> {
  return readHistorySettings(historySettingsFile(resolveHistoryLocation()));
}

/** The keys of the session rows of one listing of the Sessions view, groups opened. */
async function listedRows(context: Context): Promise<SessionTreeNode[]> {
  const tree = treeOf(context);
  const loadsBefore = tree.loads.length;
  await vscode.commands.executeCommand(COMMANDS.refreshSessions);
  const load = await waitFor(() => tree.loads[loadsBefore], {
    label: "the Sessions view to list again",
    timeoutMs: 10_000,
  });
  const rows: SessionTreeNode[] = [];
  for (const node of load.nodes as SessionTreeNode[]) {
    if (node.kind === "session") rows.push(node);
    else rows.push(...((await tree.provider.getChildren(node)) as SessionTreeNode[]));
  }
  return rows;
}

/** Stored sessions in the sandbox's store, read with a fresh reader. */
async function storedKeys(): Promise<string[]> {
  const reader = await withoutSqliteWarning(() => openHistoryStore({ mode: "read" }));
  try {
    return reader.listSessions().map((session) => session.key);
  } finally {
    reader.close();
  }
}

/**
 * History through the extension's own commands (#211), after the extension's story: recording off
 * created nothing; where history is unavailable every command says why; the command turns it on
 * and the shared settings file says so; the extension ingests through its worker
 * (`dist/history-worker.js`); a session whose files were deleted still lists, marked, and opens;
 * delete one and delete all work. The dialogs are answered by the prompt spies.
 */
function buildEditorHistorySteps(context: Context): Step[] {
  const { sandbox } = context;
  const sessionCount = sandbox.otherSessions.length + 1;
  const skip = (): string | undefined => historyUnavailable(context);
  const orbitraceFiles = (): boolean =>
    existsSync(sandbox.historyDataDir) || existsSync(join(sandbox.homeDir, HISTORY_DEFAULT_FOLDER));

  return [
    {
      name: "history (editor): with recording off the extension created nothing on disk",
      async run() {
        context.historyCapability = await withoutSqliteWarning(historyCapability);
        assert(!orbitraceFiles(), "the extension's story created the history folder");
        context.prompts = installPromptSpies(vscode.window as unknown as PromptWindowLike);
        const prompts = context.prompts;
        await vscode.commands.executeCommand(HISTORY_COMMANDS.status);
        await vscode.commands.executeCommand(HISTORY_COMMANDS.showLocation);
        await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOff);
        const shown = prompts.calls.map((call) => call.message);
        if (context.historyCapability.available) {
          assert(
            shown[0]?.startsWith("History recording is off.") === true,
            `status said: ${shown[0] ?? "nothing"}`,
          );
          assertEqual(shown[2], HISTORY_MESSAGES.alreadyOff, "Turn off with recording off");
        }
        assert(!orbitraceFiles(), "a history command created the history folder");
        assertEqual(sandboxSwitch().state, "missing", "settings file");
      },
    },
    {
      name: "history (editor): where history is unavailable every command says why and changes nothing",
      skip: () =>
        context.historyCapability?.available === true ? "history is available here" : undefined,
      async run() {
        const capability = context.historyCapability;
        assert(capability !== undefined && !capability.available, "capability");
        const prompts = promptsOf(context);
        const before = prompts.calls.length;
        for (const id of Object.values(HISTORY_COMMANDS)) await vscode.commands.executeCommand(id);
        const calls = prompts.calls.slice(before);
        assertEqual(calls.length, Object.values(HISTORY_COMMANDS).length, "messages shown");
        for (const call of calls) {
          assertEqual(call.kind, "error", "message kind");
          assertEqual(call.message, unavailableMessage(capability.reason), "message");
        }
        assert(!orbitraceFiles(), "an unavailable command created the history folder");
        log(context, `            every history command said: ${capability.reason}`);
      },
    },
    {
      name: "history (editor): Turn history recording on asks first, then the shared settings file says on",
      skip,
      async run() {
        // The transcripts come back, so there is something to record.
        if (context.projectsHidden === true) {
          renameSync(
            join(sandbox.configDir, "projects-hidden"),
            join(sandbox.configDir, "projects"),
          );
          context.projectsHidden = false;
        }
        const prompts = promptsOf(context);
        prompts.answer = (call) => (call.modal ? HISTORY_BUTTONS.turnOn : undefined);
        const before = prompts.calls.length;
        await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOn);
        const modal = prompts.calls.slice(before).find((call) => call.modal);
        assert(modal !== undefined, "Turn on did not ask in a modal dialog");
        assertEqual(modal.message, HISTORY_MESSAGES.turnOnQuestion, "question");
        assert(modal.detail?.includes("redaction is best effort") === true, "detail: best effort");
        assert(modal.detail?.includes("prompts") === true, "detail: what is stored");
        assertEqual(modal.items.join(","), HISTORY_BUTTONS.turnOn, "buttons");
        const settings = sandboxSwitch();
        assertEqual(settings.state, "ok", "settings file state");
        assertEqual(settings.recording, true, "recording in the settings file");
        if (process.platform !== "win32") {
          const mode = statSync(historySettingsFile(resolveHistoryLocation())).mode & 0o777;
          assertEqual(mode.toString(8), "600", "settings file mode");
        }
      },
    },
    {
      name: "history (editor): the extension copies every session through its own worker file",
      skip,
      timeoutMs: 60_000,
      async run() {
        const worker = join(PACKAGE_DIR, "dist", HISTORY_WORKER_FILE);
        assert(existsSync(worker), "dist/history-worker.js is missing");
        const prompts = promptsOf(context);
        const line = await waitFor(
          () => prompts.output.get(OUTPUT_CHANNEL)?.find((entry) => entry.includes("copied")),
          { label: "the extension's log line after its first copy", timeoutMs: 45_000 },
        );
        assert(line.includes("in the background worker"), `log line: ${line}`);
        const expected = countTranscripts(sandbox.configDir);
        const reader = await withoutSqliteWarning(() => openHistoryStore({ mode: "read" }));
        try {
          const totals = reader.totals();
          assertEqual(totals.sessions, sessionCount, "stored sessions");
          assertEqual(totals.files, expected.files, "stored files");
          assertEqual(totals.lines, expected.lines, "stored lines");
        } finally {
          reader.close();
        }
        assert(
          !existsSync(join(sandbox.historyDataDir, HISTORY_LOCK_FILE)),
          "the worker left its lock behind",
        );
        log(context, `            extension log: ${line}`);
      },
    },
    {
      name: "history (editor): a session whose transcript was deleted still lists, marked history, and opens",
      skip,
      async run() {
        const victim = sandbox.otherSessions[0];
        assert(victim !== undefined, "no other session in the sandbox");
        context.historyVictim = victim.key;
        rmSync(victim.transcript);
        rmSync(victim.transcript.replace(/\.jsonl$/, ""), { recursive: true, force: true });
        assert(!existsSync(victim.transcript), "the transcript is still there");

        const rows = await listedRows(context);
        const row = rows.find(
          (node) => node.kind === "session" && node.entry.summary.key === victim.key,
        );
        assert(row !== undefined, "the deleted session is no longer listed");
        assertEqual(rows.length, sessionCount, "rows in the Sessions view");
        const item = treeOf(context).provider.getTreeItem(row) as vscode.TreeItem;
        assertEqual(item.contextValue, HISTORY_SESSION_CONTEXT, "row context");
        assert(
          String(item.description).includes("history"),
          `row description: ${String(item.description)}`,
        );

        const before = spiesOf(context).panels.length;
        await vscode.commands.executeCommand(COMMANDS.visualiseSession, row);
        const record = await nextPanel(context, before);
        assertEqual(record.panel.title, panelTitle({ projectLabel: victim.projectLabel }), "title");
        record.inject({ id: IDS.historyLoad, method: "loadReplay", params: { key: victim.key } });
        const replay = resultOf(await replyTo(record, IDS.historyLoad), "loadReplay from history");
        assert(validateReplayModel(replay), "the replay from history is not a valid replay");
        const text = JSON.stringify(replay);
        assert(!text.includes(sandbox.root), "the replay from history holds a sandbox path");
        const panel = record.panel as unknown as vscode.WebviewPanel;
        const tab = tabOf(panel);
        if (tab !== undefined) await vscode.window.tabGroups.close(tab);
      },
    },
    {
      name: "history (editor): Delete a session from history removes it from the store and the view",
      skip,
      async run() {
        const key = context.historyVictim;
        assert(key !== undefined, "no deleted session");
        const prompts = promptsOf(context);
        prompts.pick = (items) => (items as StoredSessionItem[]).find((item) => item.key === key);
        prompts.answer = (call) => (call.modal ? HISTORY_BUTTONS.delete : undefined);
        const before = prompts.calls.length;
        await vscode.commands.executeCommand(HISTORY_COMMANDS.deleteSession);
        const calls = prompts.calls.slice(before);
        assertEqual(calls[0]?.kind, "quickPick", "first dialog");
        assertEqual(calls[0]?.items.length, sessionCount, "rows offered");
        assertEqual(calls[1]?.message, HISTORY_MESSAGES.deleteOneQuestion, "question");
        assertEqual(calls.at(-1)?.message, HISTORY_MESSAGES.deletedOne, "result");
        const keys = await storedKeys();
        assert(!keys.includes(key), "the session is still in the store");
        assertEqual(keys.length, sessionCount - 1, "stored sessions");
        const rows = await listedRows(context);
        assert(
          rows.every((node) => node.kind !== "session" || node.entry.summary.key !== key),
          "the deleted session is still listed",
        );
      },
    },
    {
      name: "history (editor): Turn off, then Delete all history leaves only the settings file",
      skip,
      async run() {
        const prompts = promptsOf(context);
        await vscode.commands.executeCommand(HISTORY_COMMANDS.turnOff);
        assertEqual(sandboxSwitch().recording, false, "recording after Turn off");
        prompts.answer = (call) => (call.modal ? HISTORY_BUTTONS.deleteAll : undefined);
        const before = prompts.calls.length;
        await vscode.commands.executeCommand(HISTORY_COMMANDS.deleteAll);
        const calls = prompts.calls.slice(before);
        assertEqual(calls[0]?.message, HISTORY_MESSAGES.deleteAllQuestion, "question");
        assert(calls[0]?.modal === true, "Delete all did not ask in a modal dialog");
        assertEqual(
          calls.at(-1)?.message,
          `Deleted the history store (${sessionCount - 1} sessions).`,
          "result",
        );
        const location = resolveHistoryLocation();
        assert(!existsSync(location.dbFile), "the database is still there");
        assert(existsSync(historySettingsFile(location)), "the settings file was deleted");
        assert(!existsSync(join(sandbox.homeDir, HISTORY_DEFAULT_FOLDER)), "a home store appeared");
      },
    },
  ];
}

function log(context: Context, line: string): void {
  context.log(line);
}

/** How long each clean-up action may take; the window is closed by the launcher anyway. */
const CLEAN_UP_TIMEOUT_MS = 3_000;

/** Undo what the steps changed, whatever happened. Never rejects and never hangs. */
async function cleanUp(context: Context): Promise<void> {
  if (context.projectsHidden === true) {
    try {
      renameSync(
        join(context.sandbox.configDir, "projects-hidden"),
        join(context.sandbox.configDir, "projects"),
      );
    } catch {
      // The sandbox is deleted by the launcher anyway.
    }
  }
  try {
    await withTimeout(
      Promise.resolve(vscode.commands.executeCommand("workbench.action.closeAllEditors")),
      CLEAN_UP_TIMEOUT_MS,
      "closing the editors",
    );
  } catch (error) {
    context.log(`  clean-up: ${errorMessage(error)}`);
  }
  context.prompts?.restore();
  context.spies?.restore();
}

/** Entry called by the extension host (`--extensionTestsPath`). Rejects when a step fails. */
export async function run(): Promise<void> {
  const root = process.env[SANDBOX_ENV];
  if (root === undefined || root === "") {
    throw new Error(`${SANDBOX_ENV} is not set: run the suite with 'npm run test:integration'.`);
  }
  const sandbox = readSandbox(root);
  const log = (line: string): void => {
    console.log(line);
    appendSuiteLog(root, line);
  };
  const context: Context = { sandbox, log, appDir: join(PACKAGE_DIR, ...APP_BUNDLE_SEGMENTS) };
  log(`Orbitrace integration suite, VS Code ${vscode.version}, ${process.platform}`);
  let report: StepReport = { results: [], passed: 0, failed: 1, skipped: 0 };
  try {
    // Three stories, each stopping at its own first failure. The history store first (#196), while
    // the transcripts are as the sandbox wrote them; it does not touch the extension.
    log("History store in the extension host:");
    const history = await runSteps(buildHistorySteps({ sandbox, packageDir: PACKAGE_DIR, log }), {
      timeoutMs: 20_000,
      log,
    });
    log("The extension:");
    const extension = await runSteps(buildSteps(context), { timeoutMs: 20_000, log });
    // Third: history through the extension's own commands (#211), once the extension has run its
    // whole story with recording off.
    log("History in the extension:");
    const editorHistory = await runSteps(buildEditorHistorySteps(context), {
      timeoutMs: 20_000,
      log,
    });
    report = mergeReports([history, extension, editorHistory]);
  } finally {
    await cleanUp(context);
    log(`Orbitrace integration suite: ${summarizeReport(report)}`);
    writeSuiteResult(root, report);
  }
  if (report.failed > 0 || report.passed === 0) {
    throw new Error(`integration suite failed: ${summarizeReport(report)}`);
  }
}
