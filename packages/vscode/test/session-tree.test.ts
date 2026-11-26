import { beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { createSessionCatalog, type SessionTreeNode } from "../src/session-catalog.js";
import { LIST_FAILED_MESSAGE, SessionTreeProvider } from "../src/session-tree.js";
import { ThemeIcon, TreeItemCollapsibleState, fake } from "./fakes/vscode.js";
import { fakeReplayer, makeRef, makeSummary } from "./helpers.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const live = makeSummary({ key: "claude-code:live", live: "busy", lastActivity: NOW - 60_000 });
const other = makeSummary({
  key: "claude-code:other",
  projectLabel: "marble-run",
  lastActivity: NOW - 120_000,
});
const refs = [makeRef(live, "-workspace-kite-workshop"), makeRef(other, "-workspace-marble-run")];

beforeEach(() => {
  fake.reset();
});

function setup(options: { listError?: unknown; folders?: string[] } = {}) {
  const loaded: (string | undefined)[] = [];
  const provider = new SessionTreeProvider({
    catalog: createSessionCatalog(fakeReplayer(refs, { listError: options.listError })),
    workspacePaths: () => options.folders ?? ["/workspace/kite-workshop"],
    onLoaded: (message) => loaded.push(message),
    now: () => NOW,
  });
  return { provider, loaded };
}

describe("SessionTreeProvider", () => {
  it("groups workspace sessions first and lists each group's sessions", async () => {
    const { provider, loaded } = setup();
    const top = await provider.getChildren();
    expect(top.map((node) => (node.kind === "group" ? node.group : "session"))).toEqual([
      "workspace",
      "other",
    ]);
    const group = provider.getTreeItem(top[0] as SessionTreeNode);
    expect(group.label).toBe("This workspace");
    expect(group.description).toBe("1");
    expect(group.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);
    const children = await provider.getChildren(top[0]);
    expect(children).toEqual([{ kind: "session", entry: { summary: live, inWorkspace: true } }]);
    expect(provider.lastEntries).toHaveLength(2);
    expect(loaded).toEqual([undefined]);
  });

  it("makes a session row that runs Visualise session with itself", async () => {
    const { provider } = setup({ folders: [] });
    const [first] = await provider.getChildren();
    const item = provider.getTreeItem(first as SessionTreeNode);
    expect(item.label).toBe("kite-workshop");
    expect(item.description).toBe("1 min ago · live");
    expect((item.iconPath as ThemeIcon).id).toBe("pulse");
    expect(item.contextValue).toBe("orbitrace.session");
    expect(item.command).toEqual({
      command: COMMANDS.visualiseSession,
      title: "Visualise",
      arguments: [first],
    });
    const second = (await provider.getChildren())[1] as SessionTreeNode;
    expect((provider.getTreeItem(second).iconPath as ThemeIcon).id).toBe("history");
  });

  it("shows nothing and reports a message when listing fails", async () => {
    const { provider, loaded } = setup({ listError: new Error("x") });
    await expect(provider.getChildren()).resolves.toEqual([]);
    expect(loaded).toEqual([LIST_FAILED_MESSAGE]);
  });

  it("refresh fires a change for the whole tree", () => {
    const { provider } = setup();
    const fired: unknown[] = [];
    provider.onDidChangeTreeData((value) => fired.push(value));
    provider.refresh();
    expect(fired).toEqual([undefined]);
    provider.dispose();
    provider.refresh();
    expect(fired).toHaveLength(1);
  });
});
