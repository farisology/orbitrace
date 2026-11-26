// createNodeSessionReplayer (ticket #75) end to end on a temporary config tree with the real
// Claude Code adapter. The home folder and config folder are temporary folders set through the
// environment for this test only: no test reads the real home or config folder. Every line is
// invented.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateReplay } from "../../src/index.js";
import {
  createClaudeCodeAdapter,
  createNodeSessionReplayer,
  type SessionReplayUpdate,
} from "../../src/sources/node.js";
import {
  CONTENT_MARKER,
  assistant,
  toolResult,
  toolUse,
  userPrompt,
  userResults,
} from "../parser/synthetic.js";

let base: string;
let home: string;
let config: string;
const SESSION = "sess-node-1";

async function put(file: string, text: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text, "utf8");
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "orbitrace-replayer-"));
  home = join(base, "home");
  config = join(base, "config");
  await mkdir(home, { recursive: true });
  const project = join(config, "projects", "-srv-example-project");
  await put(
    join(project, `${SESSION}.jsonl`),
    [
      userPrompt({ time: "00:00" }),
      assistant({
        time: "00:01",
        id: "msg-1",
        model: "claude-opus-5-5",
        content: [toolUse("toolu-a1", "Agent")],
      }),
      userResults({ time: "00:20", results: [toolResult("toolu-a1")] }),
      assistant({ time: "00:21", id: "msg-2", model: "claude-opus-5-5" }),
    ].join("\n") + "\n",
  );
  const subagents = join(project, SESSION, "subagents");
  await put(
    join(subagents, "agent-x1.jsonl"),
    [
      assistant({
        time: "00:02",
        id: "msg-s1",
        model: "claude-sonnet-9",
        content: [toolUse("toolu-s1", "Bash")],
      }),
      userResults({ time: "00:10", results: [toolResult("toolu-s1", true)] }),
      assistant({ time: "00:11", id: "msg-s2", model: "claude-sonnet-9" }),
    ].join("\n"),
  );
  await put(
    join(subagents, "agent-x1.meta.json"),
    JSON.stringify({
      agentType: "example-helper",
      toolUseId: "toolu-a1",
      description: `${CONTENT_MARKER}do the thing`,
    }),
  );
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Point the process's home and config folder at the temporary tree. */
function stubEnvironment(): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
}

describe("createNodeSessionReplayer", () => {
  it("lists, loads and follows a session found through the process's environment", async () => {
    stubEnvironment();
    const replayer = createNodeSessionReplayer();
    const summaries = await replayer.list();
    expect(summaries.map((s) => [s.sessionId, s.subagentCount])).toEqual([[SESSION, 1]]);
    const key = summaries[0]?.key ?? "";
    expect(key).not.toContain(SESSION);

    const model = await replayer.load(key);
    expect(validateReplay(model)).toBe(true);
    expect(model.agents.map((a) => [a.id, a.callsign, a.family])).toEqual([
      ["main", "main", "opus"],
      ["a1", "example-helper", "sonnet"],
    ]);
    expect(model.totals.failedToolCalls).toBe(1);
    expect(JSON.stringify(model)).not.toContain(CONTENT_MARKER);

    const updates: SessionReplayUpdate[] = [];
    const stop = replayer.follow(key, (update) => updates.push(update));
    await vi.waitFor(() => {
      expect(updates.length).toBeGreaterThanOrEqual(1);
    });
    stop();
    expect(updates[0]).toEqual({ type: "replay", replay: model, live: summaries[0]?.live });
  });

  it("uses given adapters and roots instead of the process's", async () => {
    const adapter = createClaudeCodeAdapter();
    const roots = await adapter.resolveRoots({
      platform: process.platform,
      homeDir: home,
      env: {},
      userRoots: [config],
    });
    const replayer = createNodeSessionReplayer({ adapters: [adapter], roots });
    expect((await replayer.list()).map((s) => s.sessionId)).toEqual([SESSION]);
  });

  it("passes host settings to root resolution", async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(base, "missing-config"));
    expect(await createNodeSessionReplayer().list()).toEqual([]);
    const replayer = createNodeSessionReplayer({ resolve: { userRoots: [config] } });
    expect((await replayer.list()).map((s) => s.sessionId)).toEqual([SESSION]);
  });

  it("rejects an unknown key with not-found", async () => {
    stubEnvironment();
    await expect(createNodeSessionReplayer().load("claude-code:0000")).rejects.toMatchObject({
      code: "not-found",
    });
  });
});
