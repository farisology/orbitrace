// The Claude Code adapter against an in-memory file system, so Windows, macOS and Linux
// trees run on any host. Every home folder, project, session id and agent id is invented.
import { describe, expect, it } from "vitest";
import {
  claudeCodeSessionKey,
  createClaudeCodeAdapter,
  cwdFromTranscriptHead,
} from "../../src/sources/node.js";
import type { SourceRoot } from "../../src/index.js";
import { collect, createMemFs, lineWithCwd } from "./helpers/mem-fs.js";

const WIN_HOME = "D:\\Profiles\\example-user";
const MAC_HOME = "/Volumes/Data/example-home";
const LINUX_HOME = "/srv/example-home";

describe("cwdFromTranscriptHead", () => {
  it("returns the first cwd and skips lines without one, malformed or cut off", () => {
    const head = [
      JSON.stringify({ type: "file-history-snapshot" }),
      '{"cwd": broken',
      lineWithCwd("/srv/work/example-project"),
      lineWithCwd("/srv/work/later"),
    ].join("\n");
    expect(cwdFromTranscriptHead(head)).toBe("/srv/work/example-project");
    expect(cwdFromTranscriptHead('{"type":"user","cwd":"/srv/wo')).toBeNull();
    expect(cwdFromTranscriptHead(JSON.stringify({ cwd: 3 }))).toBeNull();
    expect(cwdFromTranscriptHead("")).toBeNull();
  });
});

describe("claudeCodeSessionKey", () => {
  it("is stable, opaque, and differs per root, project and session", () => {
    const key = claudeCodeSessionKey("/srv/cfg", "-srv-example", "session-a");
    expect(key).toBe(claudeCodeSessionKey("/srv/cfg", "-srv-example", "session-a"));
    expect(key).toMatch(/^claude-code:[0-9a-f]{32}$/);
    expect(key).not.toContain("example");
    expect(claudeCodeSessionKey("/srv/other", "-srv-example", "session-a")).not.toBe(key);
    expect(claudeCodeSessionKey("/srv/cfg", "-srv-other", "session-a")).not.toBe(key);
    expect(claudeCodeSessionKey("/srv/cfg", "-srv-example", "session-b")).not.toBe(key);
  });

  it("ignores case for Windows roots only", () => {
    expect(claudeCodeSessionKey("E:\\Cfg", "p", "s")).toBe(
      claudeCodeSessionKey("e:\\cfg", "p", "s"),
    );
    expect(claudeCodeSessionKey("/srv/Cfg", "p", "s")).not.toBe(
      claudeCodeSessionKey("/srv/cfg", "p", "s"),
    );
  });
});

describe("Claude Code adapter on Windows paths", () => {
  const defaultRoot = `${WIN_HOME}\\.claude`;
  const projectDir = `${defaultRoot}\\projects\\E--work-widget-app`;
  const subagents = `${projectDir}\\sess-w1\\subagents`;
  const desktopRoot = "E:\\Roam\\Claude\\local-agent-mode-sessions\\org-1\\acct-1\\run-1\\.claude";

  function windowsTree() {
    return createMemFs("win32")
      .file(
        `${projectDir}\\sess-w1.jsonl`,
        `${lineWithCwd("E:\\work\\widget-app")}\r\n{"type":"assistant"}\r\n`,
        5_000,
      )
      .file(`${subagents}\\agent-a1.jsonl`, '{"type":"assistant"}\n', 9_000)
      .file(
        `${subagents}\\agent-a1.meta.json`,
        JSON.stringify({ agentType: "example-helper", toolUseId: "toolu_x" }),
      )
      .file(`${subagents}\\agent-a2.jsonl`, "", 6_000)
      .file(`${subagents}\\agent-a3.jsonl`, "", 6_000)
      .file(`${subagents}\\agent-a3.meta.json`, "{not json")
      .file(`${subagents}\\notes.txt`, "ignored")
      .file(
        `${defaultRoot}\\projects\\E--work-old\\sess-w0.jsonl`,
        `${lineWithCwd("E:\\work\\old")}\n`,
        1_000,
      )
      .file(
        `${defaultRoot}\\sessions\\4242.json`,
        JSON.stringify({
          pid: 4242,
          sessionId: "sess-w1",
          status: "busy",
          updatedAt: "1970-01-01T00:00:07.000Z",
        }),
      )
      .dir("E:\\alt-claude\\projects")
      .dir(`${WIN_HOME}\\custom\\projects\\E--x`)
      .dir(`${desktopRoot}\\projects`);
  }

  const adapter = () =>
    createClaudeCodeAdapter({ fs: windowsTree(), isProcessAlive: (pid) => pid === 4242 });

  it("resolves roots in order with reasons, removes duplicates, and marks missing roots", async () => {
    const roots = await adapter().resolveRoots({
      platform: "win32",
      homeDir: WIN_HOME,
      env: { claude_config_dir: "e:/alt-claude", APPDATA: "E:\\Roam" },
      userRoots: ["~\\custom\\projects", "   ", "relative\\cfg"],
      includeExtraRoots: true,
      hookTranscriptPaths: [
        `${defaultRoot.toUpperCase()}\\PROJECTS\\E--work-widget-app\\sess-w1.jsonl`,
        "F:\\hooked\\projects\\F--x\\sess-h.jsonl",
        "F:\\not-a-transcript.txt",
      ],
    });
    expect(roots.map((r) => [r.root, r.resolvedBy, r.available])).toEqual([
      [`${WIN_HOME}\\custom`, "user-setting", true],
      ["e:\\alt-claude", "environment", true],
      [defaultRoot, "os-default", true],
      [desktopRoot, "extra-root", true],
      ["F:\\hooked", "hook", false],
    ]);
    for (const r of roots) expect(r.runtime).toBe("claude-code");
  });

  it("leaves extra roots out unless opted in", async () => {
    const roots = await adapter().resolveRoots({
      platform: "win32",
      homeDir: WIN_HOME,
      env: { APPDATA: "E:\\Roam" },
    });
    expect(roots.map((r) => r.resolvedBy)).toEqual(["os-default"]);
  });

  it("lists sessions newest first with project, time, live status and subagent count", async () => {
    const root: SourceRoot = {
      runtime: "claude-code",
      root: defaultRoot,
      resolvedBy: "os-default",
      available: true,
    };
    const sessions = await adapter().listSessions(root);
    expect(
      sessions.map((s) => [s.sessionId, s.projectLabel, s.lastActivity, s.live, s.subagentCount]),
    ).toEqual([
      ["sess-w1", "widget-app", 9_000, "busy", 3],
      ["sess-w0", "old", 1_000, "ended", 0],
    ]);
    expect(sessions[0]?.locator).toBe(`${projectDir}\\sess-w1.jsonl`);
    expect(sessions[0]?.source).toBe(root);
    expect(sessions[0]?.key).toBe(
      claudeCodeSessionKey(defaultRoot, "E--work-widget-app", "sess-w1"),
    );
  });

  it("opens a session with its subagents and meta files", async () => {
    const fs = windowsTree();
    const a = createClaudeCodeAdapter({ fs, isProcessAlive: () => false });
    const root: SourceRoot = {
      runtime: "claude-code",
      root: defaultRoot,
      resolvedBy: "os-default",
      available: true,
    };
    const [ref] = await a.listSessions(root, { limit: 1 });
    expect(ref).toBeDefined();
    const opened = fs.linesOpened.length;
    const input = await a.openSession(ref!);
    expect(fs.linesOpened.length).toBe(opened); // nothing read until iterated
    expect(await collect(input.main)).toHaveLength(2);
    expect(input.subagents.map((s) => [s.agentId, s.meta])).toEqual([
      ["a1", { agentType: "example-helper", toolUseId: "toolu_x" }],
      ["a2", null],
      ["a3", null],
    ]);
    expect(await collect(input.subagents[0]!.lines)).toEqual(['{"type":"assistant"}']);
  });
});

describe("Claude Code adapter on macOS paths", () => {
  const defaultRoot = `${MAC_HOME}/.claude`;
  const desktopBase = `${MAC_HOME}/Library/Application Support/Claude/local-agent-mode-sessions`;

  it("finds desktop config roots within the depth and folder limits", async () => {
    const fs = createMemFs("posix")
      .dir(`${defaultRoot}/projects`)
      .dir(`${desktopBase}/org-b/acct/run-2/.claude/projects`)
      .dir(`${desktopBase}/org-a/acct/run-1/.claude/projects`)
      .dir(`${desktopBase}/org-a/acct/run-1/.claude/projects/nested/.claude/projects`)
      .dir(`${desktopBase}/a/b/c/d/e/f/g/projects`);
    const context = { platform: "darwin", homeDir: MAC_HOME, env: {}, includeExtraRoots: true };
    const roots = await createClaudeCodeAdapter({ fs }).resolveRoots(context);
    expect(roots.filter((r) => r.resolvedBy === "extra-root").map((r) => r.root)).toEqual([
      `${desktopBase}/org-a/acct/run-1/.claude`,
      `${desktopBase}/org-b/acct/run-2/.claude`,
    ]);
    const limited = await createClaudeCodeAdapter({ fs, extraRootScanLimit: 3 }).resolveRoots(
      context,
    );
    expect(limited.filter((r) => r.resolvedBy === "extra-root")).toEqual([]);
    const shallow = await createClaudeCodeAdapter({ fs, extraRootScanDepth: 3 }).resolveRoots(
      context,
    );
    expect(shallow.filter((r) => r.resolvedBy === "extra-root")).toEqual([]);
  });

  it("reports an unavailable default root and skips a missing desktop folder", async () => {
    const roots = await createClaudeCodeAdapter({ fs: createMemFs("posix") }).resolveRoots({
      platform: "darwin",
      homeDir: MAC_HOME,
      env: {},
      includeExtraRoots: true,
    });
    expect(roots).toEqual([
      { runtime: "claude-code", root: defaultRoot, resolvedBy: "os-default", available: false },
    ]);
  });

  it("uses unknown live status when there is no registry, and the folder name without a cwd", async () => {
    const fs = createMemFs("posix").file(
      `${defaultRoot}/projects/-srv-work-gadget/sess-m1.jsonl`,
      `${JSON.stringify({ type: "mode" })}\n`,
      2_000,
    );
    const root: SourceRoot = {
      runtime: "claude-code",
      root: defaultRoot,
      resolvedBy: "os-default",
      available: true,
    };
    const [session] = await createClaudeCodeAdapter({ fs }).listSessions(root);
    expect(session).toMatchObject({
      projectLabel: "gadget",
      live: "unknown",
      subagentCount: 0,
      lastActivity: 2_000,
    });
  });
});

describe("Claude Code adapter on Linux paths", () => {
  const defaultRoot = `${LINUX_HOME}/.claude`;
  const projects = `${defaultRoot}/projects`;

  function linuxTree() {
    return createMemFs("posix")
      .file(
        `${projects}/-srv-work-alpha/sess-1.jsonl`,
        `${lineWithCwd("/srv/work/alpha-app")}\n`,
        1_000,
      )
      .file(
        `${projects}/-srv-work-alpha/sess-2.jsonl`,
        `${JSON.stringify({ type: "mode" })}\n`,
        3_000,
      )
      .file(
        `${projects}/-srv-work-beta/sess-3.jsonl`,
        `${JSON.stringify({ type: "mode" })}\n`,
        2_000,
      )
      .file(`${projects}/-srv-work-beta/not-a-transcript.json`, "{}")
      .file(`${projects}/-srv-work-beta/.jsonl`, "")
      .file(`${projects}/stray-file.jsonl`, "")
      .file(
        `${defaultRoot}/sessions/111.json`,
        JSON.stringify({
          sessionId: "sess-3",
          status: "idle",
          cwd: "/srv/work/beta-renamed",
          updatedAt: "1970-01-01T00:00:04.000Z",
        }),
      )
      .file(
        `${defaultRoot}/sessions/222.json`,
        JSON.stringify({ pid: 222, sessionId: "sess-2", status: "busy" }),
      )
      .dir(`${projects}/-srv-locked`)
      .deny(`${projects}/-srv-locked`);
  }

  const root: SourceRoot = {
    runtime: "claude-code",
    root: defaultRoot,
    resolvedBy: "os-default",
    available: true,
  };

  it("labels from the registry, then a sibling transcript's cwd, and applies registry times", async () => {
    const adapter = createClaudeCodeAdapter({
      fs: linuxTree(),
      isProcessAlive: (pid) => pid === 111,
    });
    const sessions = await adapter.listSessions(root);
    expect(sessions.map((s) => [s.sessionId, s.projectLabel, s.lastActivity, s.live])).toEqual([
      ["sess-3", "beta-renamed", 4_000, "idle"],
      ["sess-2", "alpha-app", 3_000, "ended"],
      ["sess-1", "alpha-app", 1_000, "ended"],
    ]);
  });

  it("applies since and limit", async () => {
    const adapter = createClaudeCodeAdapter({ fs: linuxTree(), isProcessAlive: () => false });
    expect((await adapter.listSessions(root, { since: 2_500 })).map((s) => s.sessionId)).toEqual([
      "sess-3",
      "sess-2",
    ]);
    expect((await adapter.listSessions(root, { limit: 1 })).map((s) => s.sessionId)).toEqual([
      "sess-3",
    ]);
    expect(await adapter.listSessions(root, { limit: 0 })).toEqual([]);
  });

  it("yields no sessions for a missing root, a root without projects, or another runtime", async () => {
    const adapter = createClaudeCodeAdapter({ fs: linuxTree() });
    expect(await adapter.listSessions({ ...root, root: "/srv/missing" })).toEqual([]);
    expect(await adapter.listSessions({ ...root, root: `${defaultRoot}/sessions` })).toEqual([]);
    expect(await adapter.listSessions({ ...root, runtime: "other" as "claude-code" })).toEqual([]);
  });

  it("rejects opening a session whose transcript is gone", async () => {
    const adapter = createClaudeCodeAdapter({ fs: linuxTree() });
    const [ref] = await adapter.listSessions(root, { limit: 1 });
    await expect(
      adapter.openSession({ ...ref!, locator: `${projects}/gone/sess-x.jsonl` }),
    ).rejects.toThrow(/not found/);
  });

  it("keeps a user root that is really named projects when it holds a projects folder", async () => {
    const fs = createMemFs("posix").dir("/srv/projects/projects/-x");
    const roots = await createClaudeCodeAdapter({ fs }).resolveRoots({
      platform: "linux",
      homeDir: LINUX_HOME,
      env: {},
      userRoots: ["/srv/projects"],
    });
    expect(roots[0]).toMatchObject({
      root: "/srv/projects",
      resolvedBy: "user-setting",
      available: true,
    });
  });

  it("has a runtime id, a display name and live support (#74)", () => {
    const adapter = createClaudeCodeAdapter({ fs: createMemFs("posix") });
    expect(adapter.runtime).toBe("claude-code");
    expect(adapter.displayName).toBe("Claude Code");
    expect(adapter.watchSession).toBeTypeOf("function");
  });
});
