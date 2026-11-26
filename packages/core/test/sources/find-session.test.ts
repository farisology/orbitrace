// findSessionByKey (ticket #75): lookup of a SessionRef by its opaque key. Invented sessions.
import { describe, expect, it } from "vitest";
import {
  findSessionByKey,
  type SessionRef,
  type SourceAdapter,
  type SourceRoot,
} from "../../src/index.js";

const rootA: SourceRoot = {
  runtime: "claude-code",
  root: "/srv/example-a",
  resolvedBy: "user-setting",
  available: true,
};
const rootB: SourceRoot = { ...rootA, root: "/srv/example-b", resolvedBy: "os-default" };

function ref(key: string, root: SourceRoot, lastActivity: number): SessionRef {
  return {
    key,
    runtime: "claude-code",
    source: root,
    projectLabel: "example-project",
    sessionId: `sess-${key}`,
    lastActivity,
    live: "unknown",
    subagentCount: 0,
    locator: `${root.root}/projects/example/${key}.jsonl`,
  };
}

function adapter(
  byRoot: ReadonlyMap<string, readonly SessionRef[]>,
  calls: string[],
): SourceAdapter {
  return {
    runtime: "claude-code",
    displayName: "Example",
    resolveRoots: async () => [],
    listSessions: async (root, options) => {
      calls.push(JSON.stringify(options ?? {}));
      return byRoot.get(root.root) ?? [];
    },
    openSession: async () => ({ main: [], subagents: [] }),
  };
}

describe("findSessionByKey", () => {
  const sessions = new Map([
    [rootA.root, [ref("k-1", rootA, 3_000), ref("k-2", rootA, 2_000)]],
    [rootB.root, [ref("k-3", rootB, 1_000)]],
  ]);

  it("finds a session under any root, listing without since or limit", async () => {
    const calls: string[] = [];
    const found = await findSessionByKey([rootA, rootB], [adapter(sessions, calls)], "k-3");
    expect(found?.key).toBe("k-3");
    expect(found?.source).toBe(rootB);
    expect(calls).toEqual(["{}", "{}"]);
  });

  it("returns null for an unknown key", async () => {
    expect(await findSessionByKey([rootA, rootB], [adapter(sessions, [])], "k-9")).toBeNull();
  });

  it("returns null without listing for an empty key", async () => {
    const calls: string[] = [];
    expect(await findSessionByKey([rootA], [adapter(sessions, calls)], "")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("returns null when no adapter matches the roots", async () => {
    expect(await findSessionByKey([rootA], [], "k-1")).toBeNull();
  });
});
