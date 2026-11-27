/**
 * The integration suite (ticket #102). Runs inside a real VS Code extension host, launched by
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

import { appendFileSync, existsSync, realpathSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  EDITOR_HOST_META_VALUE,
  parseTransportMessage,
  validateReplay,
  type SessionSummary,
} from "@orbitrace/core";
import { APP_BUNDLE_SEGMENTS } from "../src/app-bundle.js";
import { COMMANDS } from "../src/commands.js";
import { PANEL_VIEW_TYPE } from "../src/panels.js";
import { GROUP_TITLES, type SessionTreeNode } from "../src/session-catalog.js";
import { panelTitle } from "../src/session-labels.js";
import { LIST_FAILED_MESSAGE } from "../src/session-tree.js";
import { pathInsideBase, policyProblems, readPage } from "./html-checks.js";
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
          assert(validateReplay(result), "the replay sent to the app is not a valid replay");
        } else {
          const live = await waitFor(() => liveMessages(record, open.id)[0], {
            label: "the first live update for the app",
            timeoutMs: 10_000,
          });
          const replay = liveReplayOf(live, "the first live update for the app");
          assert(validateReplay(replay), "the live replay is not a valid replay");
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
        assert(validateReplay(loaded), "loadReplay did not return a valid replay");

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
    report = await runSteps(buildSteps(context), { timeoutMs: 20_000, log });
  } finally {
    await cleanUp(context);
    log(`Orbitrace integration suite: ${summarizeReport(report)}`);
    writeSuiteResult(root, report);
  }
  if (report.failed > 0 || report.passed === 0) {
    throw new Error(`integration suite failed: ${summarizeReport(report)}`);
  }
}
