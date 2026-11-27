// The Node file system and a full adapter run on a fake config tree in a temporary folder.
// The home folder is a temporary folder too: no test reads the real home folder or the real
// config folder, and the environment passed in is built here, not taken from the process.
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listSessions, resolveSources } from "../../src/index.js";
import {
  claudeCodeAdapter,
  createClaudeCodeAdapter,
  createNodeFileSystem,
  nodeResolveContext,
} from "../../src/sources/node.js";
import { collect, lineWithCwd } from "./helpers/mem-fs.js";

let base: string;

/**
 * Appended to the name of a test that makes symbolic links and skips on Windows, where creating
 * one needs administrator rights or Developer Mode: the reason there, nothing elsewhere (#210).
 */
const WINDOWS_NO_SYMLINKS =
  process.platform === "win32"
    ? " (skipped on Windows: creating a symbolic link needs administrator rights or Developer Mode)"
    : "";

async function put(file: string, text: string, mtimeSeconds?: number): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text, "utf8");
  if (mtimeSeconds !== undefined) await utimes(file, mtimeSeconds, mtimeSeconds);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "orbitrace-sources-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("createNodeFileSystem", () => {
  it("lists, stats, reads text, heads and lines (LF and CRLF)", async () => {
    const dir = join(base, "fs");
    await put(join(dir, "a.jsonl"), "one\r\ntwo\nthree", 1_000);
    await mkdir(join(dir, "sub"));
    const fs = createNodeFileSystem();
    const entries = [...(await fs.readDir(dir))].sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: "a.jsonl", isFile: true, isDirectory: false },
      { name: "sub", isFile: false, isDirectory: true },
    ]);
    expect(await fs.stat(join(dir, "a.jsonl"))).toEqual({
      isFile: true,
      isDirectory: false,
      mtimeMs: 1_000_000,
    });
    expect(await fs.readText(join(dir, "a.jsonl"))).toBe("one\r\ntwo\nthree");
    expect(await fs.readHead(join(dir, "a.jsonl"), 4)).toBe("one\r");
    expect(await fs.readHead(join(dir, "a.jsonl"), 1_000)).toBe("one\r\ntwo\nthree");
    const lines = fs.readLines(join(dir, "a.jsonl"));
    expect(await collect(lines)).toEqual(["one", "two", "three"]);
    expect(await collect(lines)).toEqual(["one", "two", "three"]); // re-iterable
    expect(await fs.realPath(dir)).toBeTypeOf("string");
  });

  it("rejects for missing paths", async () => {
    const fs = createNodeFileSystem();
    const missing = join(base, "fs", "missing");
    await expect(fs.readDir(missing)).rejects.toThrow();
    await expect(fs.stat(missing)).rejects.toThrow();
    await expect(fs.readHead(missing, 10)).rejects.toThrow();
    await expect(collect(fs.readLines(missing))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    `reports symbolic links as their targets${WINDOWS_NO_SYMLINKS}`,
    async () => {
      const dir = join(base, "links");
      await put(join(dir, "target.jsonl"), "x");
      await symlink(join(dir, "target.jsonl"), join(dir, "link.jsonl"));
      await symlink(join(dir, "nowhere"), join(dir, "broken"));
      const entries = await createNodeFileSystem().readDir(dir);
      expect(entries.find((e) => e.name === "link.jsonl")).toEqual({
        name: "link.jsonl",
        isFile: true,
        isDirectory: false,
      });
      expect(entries.find((e) => e.name === "broken")).toEqual({
        name: "broken",
        isFile: false,
        isDirectory: false,
      });
    },
  );
});

describe("Claude Code adapter on a temporary config tree", () => {
  it("resolves, lists and opens sessions end to end", async () => {
    const home = join(base, "home");
    const config = join(home, ".claude");
    const alt = join(base, "alt-config");
    const project = join(config, "projects", "-work-example-project");
    await put(
      join(project, "sess-a.jsonl"),
      `${lineWithCwd("/work/example-project")}\n{"type":"assistant"}\n`,
      1_000,
    );
    await put(
      join(project, "sess-a", "subagents", "agent-x1.jsonl"),
      '{"type":"assistant"}\n',
      3_000,
    );
    await put(
      join(project, "sess-a", "subagents", "agent-x1.meta.json"),
      JSON.stringify({ agentType: "example-helper" }),
    );
    await put(join(project, "sess-b.jsonl"), `${lineWithCwd("/work/example-project")}\n`, 2_000);
    await put(
      join(config, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "sess-b", status: "busy" }),
    );
    await put(
      join(config, "sessions", "0.json"),
      JSON.stringify({ pid: 0, sessionId: "sess-a", status: "busy" }),
    );
    await put(
      join(alt, "projects", "-work-other", "sess-c.jsonl"),
      `${lineWithCwd("/work/other-app")}\n`,
      500,
    );

    const context = nodeResolveContext({ userRoots: [join(alt, "projects")] });
    const roots = await resolveSources(
      { ...context, homeDir: home, env: { CLAUDE_CONFIG_DIR: config } },
      [claudeCodeAdapter],
    );
    expect(
      roots.map((r) => [r.root === alt, r.root === config, r.resolvedBy, r.available]),
    ).toEqual([
      [true, false, "user-setting", true],
      [false, true, "environment", true],
    ]);

    const sessions = await listSessions(roots, [claudeCodeAdapter]);
    expect(
      sessions.map((s) => [s.sessionId, s.projectLabel, s.lastActivity, s.live, s.subagentCount]),
    ).toEqual([
      ["sess-a", "example-project", 3_000_000, "ended", 1],
      ["sess-b", "example-project", 2_000_000, "busy", 0],
      ["sess-c", "other-app", 500_000, "unknown", 0], // no registry under this root
    ]);

    const input = await claudeCodeAdapter.openSession(sessions[0]!);
    expect(await collect(input.main)).toHaveLength(2);
    expect(input.subagents).toHaveLength(1);
    expect(input.subagents[0]).toMatchObject({
      agentId: "x1",
      meta: { agentType: "example-helper" },
    });
    expect(await collect(input.subagents[0]!.lines)).toEqual(['{"type":"assistant"}']);
  });

  it.skipIf(process.platform === "win32")(
    `removes a root reached through a symbolic link${WINDOWS_NO_SYMLINKS}`,
    async () => {
      const real = join(base, "real-config");
      await mkdir(join(real, "projects"), { recursive: true });
      const link = join(base, "linked-config");
      await symlink(real, link);
      const roots = await createClaudeCodeAdapter().resolveRoots({
        platform: process.platform,
        homeDir: join(base, "no-home"),
        env: { CLAUDE_CONFIG_DIR: real },
        userRoots: [link],
      });
      expect(roots.map((r) => [r.root === link, r.resolvedBy, r.available])).toEqual([
        [true, "user-setting", true],
        [false, "os-default", false],
      ]);
    },
  );
});

describe("nodeResolveContext", () => {
  it("takes the OS, home folder and environment from the process, plus host settings", () => {
    const context = nodeResolveContext({ includeExtraRoots: true, userRoots: ["/srv/example"] });
    expect(context.platform).toBe(process.platform);
    expect(typeof context.homeDir).toBe("string");
    expect(context.env === process.env).toBe(true);
    expect(context.includeExtraRoots).toBe(true);
    expect(context.userRoots).toEqual(["/srv/example"]);
  });
});
