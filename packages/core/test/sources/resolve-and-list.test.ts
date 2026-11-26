// resolveSources, listSessions and the browser-safe helpers, driven by fake adapters.
// Every root, project and session name is invented.
import { describe, expect, it } from "vitest";
import {
  compareSessionsNewestFirst,
  describeResolution,
  listSessions,
  normalizeListOptions,
  resolveSources,
  sourceRootKey,
  toSessionSummary,
  type ResolveRootsContext,
  type SessionRef,
  type SourceAdapter,
  type SourceRoot,
} from "../../src/index.js";

const CONTEXT: ResolveRootsContext = { platform: "linux", homeDir: "/srv/example-home", env: {} };

function root(path: string, resolvedBy: SourceRoot["resolvedBy"], available = true): SourceRoot {
  return { runtime: "claude-code", root: path, resolvedBy, available };
}

function ref(key: string, source: SourceRoot, lastActivity: number): SessionRef {
  return {
    key,
    runtime: "claude-code",
    source,
    projectLabel: "example-project",
    sessionId: `session-${key}`,
    lastActivity,
    live: "unknown",
    subagentCount: 0,
    locator: `${source.root}/projects/example/session-${key}.jsonl`,
  };
}

function fakeAdapter(
  roots: readonly SourceRoot[],
  sessions: ReadonlyMap<string, readonly SessionRef[] | Error> = new Map(),
): SourceAdapter & { calls: { root: SourceRoot; options: unknown }[] } {
  const calls: { root: SourceRoot; options: unknown }[] = [];
  return {
    runtime: "claude-code",
    displayName: "Fake",
    calls,
    async resolveRoots() {
      return roots;
    },
    async listSessions(r, options) {
      calls.push({ root: r, options });
      const found = sessions.get(r.root) ?? [];
      if (found instanceof Error) throw found;
      return found;
    },
    async openSession() {
      return { main: [], subagents: [] };
    },
  };
}

describe("sourceRootKey", () => {
  it("ignores trailing separators and Windows case", () => {
    expect(sourceRootKey({ runtime: "claude-code", root: "/srv/cfg/" })).toBe(
      sourceRootKey({ runtime: "claude-code", root: "/srv/cfg" }),
    );
    expect(sourceRootKey({ runtime: "claude-code", root: "E:\\Cfg\\" })).toBe(
      sourceRootKey({ runtime: "claude-code", root: "e:/cfg" }),
    );
    expect(sourceRootKey({ runtime: "claude-code", root: "/srv/Cfg" })).not.toBe(
      sourceRootKey({ runtime: "claude-code", root: "/srv/cfg" }),
    );
    expect(sourceRootKey({ runtime: "claude-code", root: "/" })).toBe("claude-code\u0000/");
  });
});

describe("resolveSources", () => {
  it("orders roots by resolution across adapters and removes duplicates, first wins", async () => {
    const a = fakeAdapter([root("/srv/default", "os-default"), root("/srv/hooked", "hook")]);
    const b = fakeAdapter([
      root("/srv/mine", "user-setting"),
      root("/srv/default/", "environment"),
      root("/srv/extra", "extra-root"),
    ]);
    const roots = await resolveSources(CONTEXT, [a, b]);
    expect(roots.map((r) => [r.root, r.resolvedBy])).toEqual([
      ["/srv/mine", "user-setting"],
      ["/srv/default/", "environment"],
      ["/srv/extra", "extra-root"],
      ["/srv/hooked", "hook"],
    ]);
  });

  it("returns nothing without adapters", async () => {
    expect(await resolveSources(CONTEXT, [])).toEqual([]);
  });
});

describe("normalizeListOptions", () => {
  it("keeps finite since and floors a non-negative limit", () => {
    expect(normalizeListOptions({ since: 5, limit: 2.7 })).toEqual({ since: 5, limit: 2 });
    expect(normalizeListOptions({ since: Number.NaN, limit: -3 })).toEqual({
      since: undefined,
      limit: 0,
    });
    expect(normalizeListOptions()).toEqual({ since: undefined, limit: undefined });
    expect(normalizeListOptions({ limit: Number.POSITIVE_INFINITY })).toEqual({
      since: undefined,
      limit: Number.POSITIVE_INFINITY,
    });
  });
});

describe("compareSessionsNewestFirst", () => {
  it("sorts by time descending, then by key", () => {
    const r = root("/srv/cfg", "os-default");
    const list = [ref("b", r, 10), ref("c", r, 30), ref("a", r, 10)].sort(
      compareSessionsNewestFirst,
    );
    expect(list.map((s) => s.key)).toEqual(["c", "a", "b"]);
  });
});

describe("listSessions", () => {
  const r1 = root("/srv/one", "user-setting");
  const r2 = root("/srv/two", "os-default");
  const r3 = root("/srv/broken", "hook");

  it("merges roots newest first, drops duplicate keys and roots that fail", async () => {
    const adapter = fakeAdapter(
      [],
      new Map<string, readonly SessionRef[] | Error>([
        ["/srv/one", [ref("x", r1, 50), ref("y", r1, 10)]],
        ["/srv/two", [ref("z", r2, 40), ref("x", r2, 99)]],
        ["/srv/broken", new Error("unreadable")],
      ]),
    );
    const sessions = await listSessions([r1, r2, r3], [adapter]);
    expect(sessions.map((s) => [s.key, s.source.root])).toEqual([
      ["x", "/srv/one"],
      ["z", "/srv/two"],
      ["y", "/srv/one"],
    ]);
  });

  it("applies since and limit, and passes them to the adapter", async () => {
    const adapter = fakeAdapter(
      [],
      new Map([
        ["/srv/one", [ref("x", r1, 50), ref("y", r1, 10)]],
        ["/srv/two", [ref("z", r2, 40)]],
      ]),
    );
    const sessions = await listSessions([r1, r2], [adapter], { since: 20, limit: 1 });
    expect(sessions.map((s) => s.key)).toEqual(["x"]);
    expect(adapter.calls[0]?.options).toEqual({ since: 20, limit: 1 });
  });

  it("returns nothing for limit 0 or a root without a matching adapter", async () => {
    const adapter = fakeAdapter([], new Map([["/srv/one", [ref("x", r1, 50)]]]));
    expect(await listSessions([r1], [adapter], { limit: 0 })).toEqual([]);
    expect(adapter.calls).toEqual([]);
    expect(await listSessions([r1], [])).toEqual([]);
  });
});

describe("toSessionSummary", () => {
  it("keeps only the path-free fields", () => {
    const full = {
      ...ref("x", root("/srv/one", "os-default"), 5),
      extra: "not copied",
    } as SessionRef;
    const summary = toSessionSummary(full);
    expect(summary).toEqual({
      key: "x",
      runtime: "claude-code",
      projectLabel: "example-project",
      sessionId: "session-x",
      lastActivity: 5,
      live: "unknown",
      subagentCount: 0,
    });
    expect(JSON.stringify(summary)).not.toContain("/srv/one");
  });
});

describe("describeResolution", () => {
  it("gives a path-free reason for every resolution", () => {
    const reasons = (
      ["user-setting", "environment", "os-default", "extra-root", "hook"] as const
    ).map((resolvedBy) =>
      describeResolution({ runtime: "claude-code", resolvedBy, available: true }),
    );
    expect(reasons[1]).toContain("CLAUDE_CONFIG_DIR");
    expect(new Set(reasons).size).toBe(5);
    for (const reason of reasons) expect(reason).not.toContain("/");
  });

  it("says when the folder was missing", () => {
    expect(
      describeResolution({ runtime: "claude-code", resolvedBy: "os-default", available: false }),
    ).toMatch(/missing or not readable/);
  });
});
