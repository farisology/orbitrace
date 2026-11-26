import { describe, expect, it } from "vitest";
import {
  childNodes,
  createSessionCatalog,
  topLevelNodes,
  workspaceFirst,
  type CatalogEntry,
} from "../src/session-catalog.js";
import { fakeReplayer, makeRef, makeSummary } from "./helpers.js";

const newest = makeSummary({
  key: "claude-code:a",
  projectLabel: "marble-run",
  lastActivity: 3000,
});
const middle = makeSummary({
  key: "claude-code:b",
  projectLabel: "kite-workshop",
  lastActivity: 2000,
});
const oldest = makeSummary({
  key: "claude-code:c",
  projectLabel: "kite-workshop",
  lastActivity: 1000,
});
const refs = [
  makeRef(newest, "-workspace-marble-run"),
  makeRef(middle, "-workspace-kite-workshop"),
  makeRef(oldest, "-workspace-kite-workshop"),
];

describe("workspaceFirst", () => {
  it("moves workspace entries first and keeps the order inside each group", () => {
    const entries: CatalogEntry[] = [
      { summary: newest, inWorkspace: false },
      { summary: middle, inWorkspace: true },
      { summary: oldest, inWorkspace: true },
    ];
    expect(workspaceFirst(entries).map((entry) => entry.summary.key)).toEqual([
      "claude-code:b",
      "claude-code:c",
      "claude-code:a",
    ]);
  });
});

describe("createSessionCatalog", () => {
  it("lists workspace sessions first, newest first within each group", async () => {
    const catalog = createSessionCatalog(fakeReplayer(refs));
    const entries = await catalog.list(["/workspace/kite-workshop"]);
    expect(entries.map((entry) => [entry.summary.key, entry.inWorkspace])).toEqual([
      ["claude-code:b", true],
      ["claude-code:c", true],
      ["claude-code:a", false],
    ]);
  });

  it("keeps the replayer order with no workspace folder", async () => {
    const catalog = createSessionCatalog(fakeReplayer(refs));
    const entries = await catalog.list([]);
    expect(entries.map((entry) => entry.summary.key)).toEqual([
      "claude-code:a",
      "claude-code:b",
      "claude-code:c",
    ]);
    expect(entries.every((entry) => !entry.inWorkspace)).toBe(true);
  });

  it("treats a session whose ref cannot be found as outside the workspace", async () => {
    const replayer = fakeReplayer(refs);
    const catalog = createSessionCatalog({
      list: replayer.list,
      find: () => Promise.reject(new Error("gone")),
    });
    const entries = await catalog.list(["/workspace/kite-workshop"]);
    expect(entries.every((entry) => !entry.inWorkspace)).toBe(true);
  });

  it("rejects list when the replayer cannot list", async () => {
    const catalog = createSessionCatalog(fakeReplayer(refs, { listError: new Error("x") }));
    await expect(catalog.list([])).rejects.toThrow();
  });

  it("picks the workspace session, else the most recent, else the demo", async () => {
    const catalog = createSessionCatalog(fakeReplayer(refs));
    await expect(catalog.pick(["/workspace/kite-workshop"])).resolves.toMatchObject({
      kind: "session",
      reason: "workspace",
      entry: { summary: { key: "claude-code:b" } },
    });
    await expect(catalog.pick(["/workspace/elsewhere"])).resolves.toMatchObject({
      kind: "session",
      reason: "recent",
      entry: { summary: { key: "claude-code:a" } },
    });
    await expect(createSessionCatalog(fakeReplayer([])).pick([])).resolves.toEqual({
      kind: "demo",
      reason: "none",
    });
    await expect(
      createSessionCatalog(fakeReplayer(refs, { listError: new Error("x") })).pick([]),
    ).resolves.toEqual({ kind: "demo", reason: "error" });
  });
});

describe("topLevelNodes and childNodes", () => {
  const inside: CatalogEntry = { summary: middle, inWorkspace: true };
  const outside: CatalogEntry = { summary: newest, inWorkspace: false };

  it("groups when sessions are both inside and outside the workspace", () => {
    const nodes = topLevelNodes([inside, outside]);
    expect(nodes).toEqual([
      { kind: "group", group: "workspace", entries: [inside] },
      { kind: "group", group: "other", entries: [outside] },
    ]);
    expect(childNodes(nodes[1] as (typeof nodes)[number])).toEqual([
      { kind: "session", entry: outside },
    ]);
  });

  it("lists sessions flat when there is only one kind, and nothing when empty", () => {
    expect(topLevelNodes([outside])).toEqual([{ kind: "session", entry: outside }]);
    expect(topLevelNodes([inside])).toEqual([{ kind: "session", entry: inside }]);
    expect(topLevelNodes([])).toEqual([]);
    expect(childNodes({ kind: "session", entry: inside })).toEqual([]);
  });
});
