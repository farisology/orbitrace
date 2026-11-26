/**
 * The golden replay files under fixtures/replays/: each one is what the replay pipeline of
 * @orbitrace/core makes of a fixture session. The first block is the golden test itself: it
 * runs the pipeline again and fails, naming what changed, when a committed file differs.
 *
 * When it fails and the change is intended, run `npm run goldens -w @orbitrace/fixtures` and
 * commit the files it rewrites. Never edit a golden by hand.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  EFFORT_LEVELS,
  FORBIDDEN_REPLAY_KEYS,
  KNOWN_MODEL_FAMILIES,
  REPLAY_BUILD_DEFAULTS,
  REPLAY_FORMAT_VERSION,
  describeReplayProblems,
  validateReplay,
  type ReplayAgent,
  type ReplayModel,
} from "@orbitrace/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONFIG_FOLDER,
  DEMO_GOLDEN_REPLAY_PATH,
  DEMO_SCENARIO,
  FIXTURES_DIR,
  GOLDENS_COMMAND,
  GOLDEN_REPLAYS_DIR,
  HAND_WRITTEN_REPLAYS,
  MANIFEST_FILE,
  REPLAYS_FOLDER,
  SCENARIO_NAMES,
  assertGoldenReplay,
  checkGoldenReplays,
  describeGoldenChange,
  describeGoldenReplayDiff,
  findKeys,
  fixturePaths,
  goldenReplayFile,
  goldenReplayPath,
  isGoldenReplaysCurrent,
  readFixtureManifest,
  renderGoldenReplays,
  writeFixtureTree,
  writeGoldenReplays,
  type FixtureManifest,
  type GoldenReplayFile,
  type ManifestSession,
  type ScenarioName,
} from "../src/index.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

const onDisk = (dir: string, relative: string): string => join(dir, ...relative.split("/"));

function readCommitted(name: ScenarioName): string | null {
  const path = goldenReplayPath(name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The committed golden of a scenario, parsed. Throws when it is missing. */
function committedReplay(name: ScenarioName): ReplayModel {
  return JSON.parse(readFileSync(goldenReplayPath(name), "utf8")) as ReplayModel;
}

function manifestSession(name: ScenarioName): ManifestSession {
  const session = readFixtureManifest().sessions.find((listed) => listed.name === name);
  if (session === undefined) throw new Error(`no session named ${name} in the manifest`);
  return session;
}

/** A fixtures folder in a temporary place, written by the generator with the default seed. */
function tempFixtures(): string {
  const dir = makeTempDir();
  writeFixtureTree(dir);
  return dir;
}

function editManifest(dir: string, edit: (manifest: FixtureManifest) => void): void {
  const file = join(dir, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as FixtureManifest;
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

let regenerated: GoldenReplayFile[];

beforeAll(async () => {
  regenerated = await renderGoldenReplays();
});

function regeneratedFile(name: ScenarioName): GoldenReplayFile {
  const file = regenerated.find((golden) => golden.name === name);
  if (file === undefined) throw new Error(`the pipeline wrote no golden for ${name}`);
  return file;
}

describe("the committed golden replays", () => {
  it.each(SCENARIO_NAMES)("%s is what the pipeline writes today", (name) => {
    const file = regeneratedFile(name);
    const committed = readCommitted(name);
    expect(committed, `${file.path} is not committed. Run: ${GOLDENS_COMMAND}`).not.toBeNull();
    // Each line names a place in the replay and both values, for example
    // "agents[1].end: committed 12.5, regenerated 13".
    expect(
      describeGoldenChange(committed ?? "", file.content),
      `${file.path} differs from what the pipeline writes. If the change is intended, run: ${GOLDENS_COMMAND}`,
    ).toEqual([]);
  });

  it("are the only replay files in the folder, beside the hand-written example", async () => {
    const diff = await checkGoldenReplays();
    expect(describeGoldenReplayDiff(diff)).toEqual([]);
    expect(isGoldenReplaysCurrent(diff)).toBe(true);
    const onDiskNames = readdirSync(GOLDEN_REPLAYS_DIR).sort();
    const expected = [...SCENARIO_NAMES.map(goldenReplayFile), ...HAND_WRITTEN_REPLAYS]
      .map((path) => path.slice(`${REPLAYS_FOLDER}/`.length))
      .sort();
    expect(onDiskNames).toEqual(expected);
  });

  it.each(SCENARIO_NAMES)("%s is a valid replay v1 with no forbidden key", (name) => {
    const replay: unknown = committedReplay(name);
    expect(describeReplayProblems(replay)).toEqual([]);
    expect(validateReplay(replay)).toBe(true);
    expect(findKeys(replay, FORBIDDEN_REPLAY_KEYS)).toEqual([]);
    expect(() => assertGoldenReplay(replay, name)).not.toThrow();
    expect((replay as ReplayModel).formatVersion).toBe(REPLAY_FORMAT_VERSION);
  });

  it.each(SCENARIO_NAMES)("%s is indented JSON that ends with one line break", (name) => {
    const text = readCommitted(name) ?? "";
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  it.each(SCENARIO_NAMES)(
    "%s holds nothing local: no id, path or project of its session",
    (name) => {
      const text = readCommitted(name) ?? "";
      const session = manifestSession(name);
      const local = [
        session.sessionId,
        session.project,
        session.cwd,
        ...session.subagents.map((subagent) => subagent.agentId),
      ];
      expect(local.filter((value) => text.includes(value))).toEqual([]);
      // No wall-clock time either: a replay counts seconds from the start of the session.
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    },
  );
});

describe("the golden replays and the facts in the manifest", () => {
  // The manifest's `expected` block is written by the generator, which knows what it put in
  // each transcript. The goldens come from the parser and the builder. They must agree.
  it.each(SCENARIO_NAMES)("%s has the totals the generator scripted", (name) => {
    const replay = committedReplay(name);
    const { totals, agents } = manifestSession(name).expected;
    expect(replay.totals).toMatchObject({
      agents: agents.length,
      toolCalls: totals.toolCalls,
      failedToolCalls: totals.failedToolCalls,
      replies: totals.replies,
      inputTokens: totals.usage.input_tokens,
      outputTokens: totals.usage.output_tokens,
      cacheReadTokens: totals.usage.cache_read_input_tokens,
      cacheCreationTokens: totals.usage.cache_creation_input_tokens,
    });
    const calls = replay.agents.flatMap((agent) => agent.tools);
    expect(calls.filter((call) => call.end === null)).toHaveLength(totals.unfinishedToolCalls);
    expect(calls.filter((call) => call.kind === "mcp")).toHaveLength(totals.mcpToolCalls);
    expect(calls.filter((call) => call.name.startsWith("mcp:"))).toHaveLength(totals.mcpToolCalls);
  });

  it.each(SCENARIO_NAMES)("%s has the agents the generator scripted, in spawn order", (name) => {
    const replay = committedReplay(name);
    const facts = manifestSession(name).expected.agents;
    expect(replay.agents).toHaveLength(facts.length);
    // The replay's own ids, by the runtime id the generator gave each agent.
    const replayId = new Map(facts.map((fact, index) => [fact.id, replay.agents[index]?.id]));
    const seen = replay.agents.map((agent: ReplayAgent) => ({
      id: agent.id,
      name: agent.name,
      parent: agent.parent,
      model: agent.model,
      effort: agent.effort,
      toolCalls: agent.totals.toolCalls,
      failedToolCalls: agent.totals.failedToolCalls,
      replies: agent.totals.replies,
      inputTokens: agent.totals.inputTokens,
      outputTokens: agent.totals.outputTokens,
      cacheReadTokens: agent.totals.cacheReadTokens,
      cacheCreationTokens: agent.totals.cacheCreationTokens,
    }));
    const scripted = facts.map((fact, index) => ({
      id: index === 0 ? "main" : `a${index}`,
      name: fact.agentType ?? "main",
      parent: fact.parent === null ? null : replayId.get(fact.parent),
      model: fact.model,
      effort: fact.effort,
      toolCalls: fact.toolCalls,
      failedToolCalls: fact.failedToolCalls,
      replies: fact.replies,
      inputTokens: fact.usage.input_tokens,
      outputTokens: fact.usage.output_tokens,
      cacheReadTokens: fact.usage.cache_read_input_tokens,
      cacheCreationTokens: fact.usage.cache_creation_input_tokens,
    }));
    expect(seen).toEqual(scripted);
    // A subagent that never handed back has no end; every other subagent has one.
    expect(replay.agents.slice(1).map((agent) => agent.end !== null)).toEqual(
      facts.slice(1).map((fact) => fact.finished),
    );
  });

  it.each(SCENARIO_NAMES)("%s has the waves and idle gaps the generator scripted", (name) => {
    const replay = committedReplay(name);
    const { scriptedWaves, scriptedIdleGaps } = manifestSession(name).expected;
    const waves = new Set(replay.agents.slice(1).map((agent) => agent.wave));
    // Waves are numbered from 0 with no number left out.
    expect(waves).toEqual(new Set(Array.from({ length: scriptedWaves }, (_, index) => index)));

    // Every scripted gap is longer than the contract's idle threshold, so each one is cut.
    expect(
      scriptedIdleGaps.every((gap) => gap.seconds > REPLAY_BUILD_DEFAULTS.idleGapSeconds),
    ).toBe(true);
    expect(replay.warps).toHaveLength(scriptedIdleGaps.length);
    replay.warps.forEach((warp, index) => {
      expect(warp.skipped).toBeGreaterThan(0);
      expect(warp.skipped).toBeLessThan(scriptedIdleGaps[index]?.seconds ?? 0);
    });
    const skipped = replay.warps.reduce((sum, warp) => sum + warp.skipped, 0);
    expect(replay.totals.realDuration).toBeCloseTo(replay.totals.duration + skipped, 6);
  });
});

describe("the demo golden", () => {
  it("is exported by its absolute path, and is on disk", () => {
    expect(isAbsolute(DEMO_GOLDEN_REPLAY_PATH)).toBe(true);
    expect(DEMO_GOLDEN_REPLAY_PATH).toBe(join(FIXTURES_DIR, "replays", "demo.replay.json"));
    expect(DEMO_GOLDEN_REPLAY_PATH).toBe(goldenReplayPath(DEMO_SCENARIO));
    expect(existsSync(DEMO_GOLDEN_REPLAY_PATH)).toBe(true);
  });

  it("loads the way the app will load it: read, parse, validate", () => {
    const value: unknown = JSON.parse(readFileSync(DEMO_GOLDEN_REPLAY_PATH, "utf8"));
    expect(validateReplay(value)).toBe(true);
    expect(value).toEqual(regeneratedFile(DEMO_SCENARIO).model);
  });

  it("shows what the demo scenario promises", () => {
    const demo = committedReplay(DEMO_SCENARIO);
    const subagents = demo.agents.slice(1);
    expect(subagents).toHaveLength(14);
    expect(new Set(subagents.map((agent) => agent.wave))).toEqual(new Set([0, 1, 2, 3]));
    // Every family the renderer has a shape for, less the placeholder for an unknown one.
    expect(new Set(demo.agents.map((agent) => agent.family))).toEqual(
      new Set(KNOWN_MODEL_FAMILIES.filter((family) => family !== "unknown")),
    );
    expect(new Set(demo.agents.map((agent) => agent.effort))).toEqual(new Set(EFFORT_LEVELS));
    expect(demo.warps).toHaveLength(1);
    expect(demo.totals.failedToolCalls).toBeGreaterThan(0);
    expect(demo.agents.flatMap((agent) => agent.tools).some((call) => call.kind === "mcp")).toBe(
      true,
    );
    // Callsigns are unique, and an agent type used more than once is numbered.
    const callsigns = demo.agents.map((agent) => agent.callsign);
    expect(new Set(callsigns).size).toBe(callsigns.length);
    expect(callsigns).toContain("code-reviewer#2");
  });
});

describe("the manifest's golden replay list", () => {
  it("names one file per session, in session order, and every file is on disk", () => {
    const manifest = readFixtureManifest();
    expect(manifest.goldenReplays).toEqual(SCENARIO_NAMES.map(goldenReplayFile));
    expect(manifest.sessions.map((session) => session.goldenReplay)).toEqual(
      manifest.goldenReplays,
    );
    const missing = manifest.goldenReplays.filter(
      (path) => !existsSync(onDisk(FIXTURES_DIR, path)),
    );
    expect(missing).toEqual([]);
    expect(manifest.goldenReplays).toContain("replays/demo.replay.json");
  });
});

describe("renderGoldenReplays", () => {
  it("gives one golden per session, in manifest order, with the model it was written from", () => {
    expect(regenerated.map((file) => file.name)).toEqual([...SCENARIO_NAMES]);
    expect(regenerated.map((file) => file.path)).toEqual(SCENARIO_NAMES.map(goldenReplayFile));
    for (const file of regenerated) {
      // Export drops nothing from a model the builder made: the file is the model.
      expect(JSON.parse(file.content)).toEqual(file.model);
      expect(validateReplay(file.model)).toBe(true);
      expect(findKeys(file.model, FORBIDDEN_REPLAY_KEYS)).toEqual([]);
    }
  });

  it("gives the same bytes on a second run", async () => {
    const again = await renderGoldenReplays();
    expect(again.map((file) => file.content)).toEqual(regenerated.map((file) => file.content));
  });

  it("gives the same bytes for a copy of the fixtures in another folder", async () => {
    // Other absolute paths, other file times: neither may reach a replay.
    const dir = tempFixtures();
    const elsewhere = await renderGoldenReplays(dir);
    expect(elsewhere.map((file) => file.path)).toEqual(regenerated.map((file) => file.path));
    expect(elsewhere.map((file) => file.content)).toEqual(regenerated.map((file) => file.content));
  });

  it("does not write anything", async () => {
    const dir = tempFixtures();
    await renderGoldenReplays(dir);
    expect(existsSync(join(dir, REPLAYS_FOLDER))).toBe(false);
  });

  it("reads the sessions of the folder it is given, not the committed ones", async () => {
    const dir = makeTempDir();
    writeFixtureTree(dir, { seed: "elsewhere" });
    const other = await renderGoldenReplays(dir);
    expect(other.map((file) => file.path)).toEqual(regenerated.map((file) => file.path));
    expect(other.every((file) => validateReplay(file.model))).toBe(true);
    expect(other.map((file) => file.content)).not.toEqual(regenerated.map((file) => file.content));
  });

  it("refuses a session of the manifest whose transcript is not on disk", async () => {
    const dir = tempFixtures();
    rmSync(fixturePaths("idle-gap", dir).transcript);
    await expect(renderGoldenReplays(dir)).rejects.toThrow(
      'session "idle-gap": the source adapter found 0 transcripts for it in config/, expected 1.',
    );
  });

  it("refuses a session that is on disk twice", async () => {
    const dir = tempFixtures();
    const paths = fixturePaths("idle-gap", dir);
    const copy = join(paths.configDir, "projects", "-workspace-second-copy");
    mkdirSync(copy);
    copyFileSync(paths.transcript, join(copy, `${paths.sessionId}.jsonl`));
    await expect(renderGoldenReplays(dir)).rejects.toThrow("found 2 transcripts");
  });
});

describe("readFixtureManifest", () => {
  it("reads the committed manifest", () => {
    const manifest = readFixtureManifest();
    expect(manifest).toEqual(JSON.parse(readFileSync(join(FIXTURES_DIR, MANIFEST_FILE), "utf8")));
    expect(manifest.sessions.map((session) => session.name)).toEqual([...SCENARIO_NAMES]);
    expect(readFixtureManifest(FIXTURES_DIR)).toEqual(manifest);
  });

  it("refuses a folder without a manifest, and a manifest that is not JSON", () => {
    const dir = makeTempDir();
    expect(() => readFixtureManifest(dir)).toThrow("manifest.json not found");
    writeFileSync(join(dir, MANIFEST_FILE), "{ not json");
    expect(() => readFixtureManifest(dir)).toThrow("manifest.json is not valid JSON");
  });

  it("refuses a manifest of another version, such as the one that said pending", () => {
    const dir = tempFixtures();
    editManifest(dir, (manifest) => {
      Object.assign(manifest, { manifestVersion: 1, goldenReplays: "pending" });
    });
    expect(() => readFixtureManifest(dir)).toThrow("is not a version 2 fixture manifest");
    writeFileSync(join(dir, MANIFEST_FILE), "[]\n");
    expect(() => readFixtureManifest(dir)).toThrow("is not a version 2 fixture manifest");
  });

  it("refuses a manifest without a sessions list or a goldenReplays list", () => {
    const dir = tempFixtures();
    editManifest(dir, (manifest) => {
      Object.assign(manifest, { goldenReplays: "pending" });
    });
    expect(() => readFixtureManifest(dir)).toThrow("no sessions or no goldenReplays list");
    editManifest(dir, (manifest) => {
      Object.assign(manifest, { goldenReplays: [], sessions: null });
    });
    expect(() => readFixtureManifest(dir)).toThrow("no sessions or no goldenReplays list");
  });

  it("refuses a session without a name, a session id or a golden replay", () => {
    for (const key of ["name", "sessionId", "goldenReplay"] as const) {
      const dir = tempFixtures();
      editManifest(dir, (manifest) => {
        delete (manifest.sessions[2] as Partial<ManifestSession>)[key];
      });
      expect(() => readFixtureManifest(dir)).toThrow(
        "session 2 lacks a name, a sessionId or a goldenReplay",
      );
    }
    const dir = tempFixtures();
    editManifest(dir, (manifest) => {
      (manifest.sessions as unknown[])[0] = "single-agent";
    });
    expect(() => readFixtureManifest(dir)).toThrow("session 0 lacks");
  });

  it("refuses a golden replay path that is not a file of its own in the replays folder", () => {
    const refused = [
      "../outside.replay.json",
      "replays/../../outside.replay.json",
      "replays/nested/demo.replay.json",
      "replays\\demo.replay.json",
      "/replays/demo.replay.json",
      "replays/demo.json",
      "replays/Demo.replay.json",
      "config/demo.replay.json",
      "",
      // The hand-written example is not a golden and must never be overwritten by one.
      ...HAND_WRITTEN_REPLAYS,
    ];
    for (const path of refused) {
      const dir = tempFixtures();
      editManifest(dir, (manifest) => {
        const session = manifest.sessions[0] as ManifestSession;
        session.goldenReplay = path;
        manifest.goldenReplays[0] = path;
      });
      expect(() => readFixtureManifest(dir), `goldenReplay "${path}"`).toThrow(
        'session "single-agent" names a golden replay that is not a file of its own in replays/',
      );
    }
  });

  it("refuses two sessions with one golden replay, and a list that does not match", () => {
    const shared = tempFixtures();
    editManifest(shared, (manifest) => {
      const [first, second] = manifest.sessions as [ManifestSession, ManifestSession];
      second.goldenReplay = first.goldenReplay;
    });
    expect(() => readFixtureManifest(shared)).toThrow(
      "two sessions name the same golden replay (replays/single-agent.replay.json)",
    );

    const short = tempFixtures();
    editManifest(short, (manifest) => {
      manifest.goldenReplays.pop();
    });
    expect(() => readFixtureManifest(short)).toThrow("goldenReplays does not list");

    const swapped = tempFixtures();
    editManifest(swapped, (manifest) => {
      manifest.goldenReplays.reverse();
    });
    expect(() => readFixtureManifest(swapped)).toThrow("goldenReplays does not list");
  });
});

describe("assertGoldenReplay", () => {
  const valid = (): ReplayModel => structuredClone(regeneratedFile("mcp-tools").model);

  it("accepts a replay the pipeline built", () => {
    expect(() => assertGoldenReplay(valid(), "session")).not.toThrow();
  });

  it("refuses a forbidden key at any depth and names where it is", () => {
    const withText = valid() as unknown as { agents: { tools: Record<string, unknown>[] }[] };
    const call = withText.agents[0]?.tools[0];
    if (call === undefined) throw new Error("the fixture has no tool call");
    call.input = "Synthetic value";
    expect(() => assertGoldenReplay(withText, 'session "mcp-tools"')).toThrow(
      'session "mcp-tools": the replay holds a forbidden key at agents[0].tools[0].input',
    );
    for (const key of FORBIDDEN_REPLAY_KEYS) {
      expect(() => assertGoldenReplay({ ...valid(), [key]: 1 }, "session")).toThrow(
        `session: the replay holds a forbidden key at ${key}`,
      );
    }
  });

  it("refuses a value that is not a valid replay v1 and lists the problems", () => {
    expect(() => assertGoldenReplay({ ...valid(), formatVersion: 2 }, "session")).toThrow(
      /^session: the replay is not a valid replay v1:\n- \/formatVersion: /,
    );
    expect(() => assertGoldenReplay({ ...valid(), extra: true }, "session")).toThrow(
      'has a property the format does not allow: "extra"',
    );
    for (const value of [null, undefined, [], "replay", 1, {}]) {
      expect(() => assertGoldenReplay(value, "session")).toThrow("is not a valid replay v1");
    }
  });
});

describe("describeGoldenChange", () => {
  const committed = (): string => regeneratedFile("two-waves").content;

  it("returns nothing for the same bytes", () => {
    expect(describeGoldenChange(committed(), committed())).toEqual([]);
  });

  it("names each place where the regenerated replay differs", () => {
    const changed = structuredClone(regeneratedFile("two-waves").model) as unknown as {
      agents: { end: number; tools: { failed: boolean }[]; replies: unknown[] }[];
      totals: { toolCalls: number };
    };
    const before = regeneratedFile("two-waves").model;
    (changed.agents[1] as (typeof changed.agents)[number]).end = 99;
    (
      (changed.agents[2] as (typeof changed.agents)[number]).tools[0] as { failed: boolean }
    ).failed = true;
    (changed.agents[3] as (typeof changed.agents)[number]).replies.pop();
    changed.totals.toolCalls += 1;
    const regeneratedText = `${JSON.stringify(changed, null, 2)}\n`;
    expect(describeGoldenChange(committed(), regeneratedText)).toEqual([
      `agents[1].end: committed ${before.agents[1]?.end}, regenerated 99`,
      "agents[2].tools[0].failed: committed false, regenerated true",
      `agents[3].replies: committed has ${before.agents[3]?.replies.length} item(s), regenerated has ${(before.agents[3]?.replies.length ?? 0) - 1}`,
      `totals.toolCalls: committed ${before.totals.toolCalls}, regenerated ${before.totals.toolCalls + 1}`,
    ]);
  });

  it("keeps to the limit it is given", () => {
    const other = regeneratedFile("demo").content;
    const lines = describeGoldenChange(committed(), other, 3);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(/^\.\.\. and \d+ more difference\(s\)$/);
  });

  it("says so when the data is the same and only the bytes differ", () => {
    const model: unknown = JSON.parse(committed());
    expect(describeGoldenChange(committed(), `${JSON.stringify(model)}\n`)).toEqual([
      "same data, different bytes (key order, indentation or line endings), first at line 1",
    ]);
    expect(describeGoldenChange(committed(), `${committed()}\n`)).toEqual([
      `same data, different bytes (key order, indentation or line endings), first at line ${committed().split("\n").length + 1}`,
    ]);
    const windows = committed().replace(/\n/g, "\r\n");
    expect(describeGoldenChange(windows, committed())[0]).toContain("same data, different bytes");
  });

  it("reports text that is not JSON, on either side", () => {
    expect(describeGoldenChange("{ not json", committed())).toEqual([
      "the committed file is not valid JSON",
    ]);
    expect(describeGoldenChange(committed(), "")).toEqual([
      "the regenerated text is not valid JSON",
    ]);
  });
});

describe("writeGoldenReplays", () => {
  it("writes every golden with the bytes of the committed one", async () => {
    const dir = tempFixtures();
    const written = await writeGoldenReplays(dir);
    expect(written).toEqual(SCENARIO_NAMES.map(goldenReplayFile));
    for (const name of SCENARIO_NAMES) {
      expect(readFileSync(goldenReplayPath(name, dir), "utf8")).toBe(readCommitted(name));
    }
    expect(await checkGoldenReplays(dir)).toEqual({ missing: [], changed: [], extra: [] });
  });

  it("writes the same bytes on a second run and leaves other files alone", async () => {
    const dir = tempFixtures();
    mkdirSync(join(dir, REPLAYS_FOLDER));
    const example = onDisk(dir, HAND_WRITTEN_REPLAYS[0] ?? "");
    writeFileSync(example, "kept\n");
    writeFileSync(join(dir, REPLAYS_FOLDER, "notes.txt"), "kept too\n");
    await writeGoldenReplays(dir);
    const first = readFileSync(goldenReplayPath("demo", dir));
    await writeGoldenReplays(dir);
    expect(readFileSync(goldenReplayPath("demo", dir)).equals(first)).toBe(true);
    expect(readFileSync(example, "utf8")).toBe("kept\n");
    expect(readFileSync(join(dir, REPLAYS_FOLDER, "notes.txt"), "utf8")).toBe("kept too\n");
  });

  it("repairs a golden that was edited by hand", async () => {
    const dir = tempFixtures();
    await writeGoldenReplays(dir);
    writeFileSync(goldenReplayPath("idle-gap", dir), "{}\n");
    await writeGoldenReplays(dir);
    expect(isGoldenReplaysCurrent(await checkGoldenReplays(dir))).toBe(true);
  });

  it("writes nothing when one session cannot be built", async () => {
    const dir = tempFixtures();
    // The last session fails; the ones before it must not be written either.
    rmSync(fixturePaths(DEMO_SCENARIO, dir).transcript);
    await expect(writeGoldenReplays(dir)).rejects.toThrow('session "demo"');
    expect(existsSync(join(dir, REPLAYS_FOLDER))).toBe(false);
  });
});

describe("checkGoldenReplays", () => {
  it("reports every golden as missing for a folder that has none, and writes nothing", async () => {
    const dir = tempFixtures();
    const diff = await checkGoldenReplays(dir);
    expect(diff).toEqual({ missing: SCENARIO_NAMES.map(goldenReplayFile), changed: [], extra: [] });
    expect(isGoldenReplaysCurrent(diff)).toBe(false);
    expect(existsSync(join(dir, REPLAYS_FOLDER))).toBe(false);
  });

  it("reports a missing golden, a changed one with what changed, and a stale one", async () => {
    const dir = tempFixtures();
    await writeGoldenReplays(dir);
    rmSync(goldenReplayPath("split-reply", dir));
    const edited = JSON.parse(readFileSync(goldenReplayPath("idle-gap", dir), "utf8")) as {
      warps: { skipped: number }[];
    };
    const warp = edited.warps[0];
    if (warp === undefined) throw new Error("the idle-gap golden has no warp");
    const skipped = warp.skipped;
    warp.skipped = 1;
    writeFileSync(goldenReplayPath("idle-gap", dir), `${JSON.stringify(edited, null, 2)}\n`);
    writeFileSync(join(dir, REPLAYS_FOLDER, "renamed-scenario.replay.json"), "{}\n");

    const diff = await checkGoldenReplays(dir);
    expect(diff).toEqual({
      missing: ["replays/split-reply.replay.json"],
      changed: [
        {
          path: "replays/idle-gap.replay.json",
          differences: [`warps[0].skipped: committed 1, regenerated ${skipped}`],
        },
      ],
      extra: ["replays/renamed-scenario.replay.json"],
    });
    expect(isGoldenReplaysCurrent(diff)).toBe(false);
    expect(describeGoldenReplayDiff(diff)).toEqual([
      "missing: replays/split-reply.replay.json",
      "changed: replays/idle-gap.replay.json",
      `  warps[0].skipped: committed 1, regenerated ${skipped}`,
      "not a golden: replays/renamed-scenario.replay.json",
    ]);
  });

  it("leaves the hand-written example and files that are not replays out of it", async () => {
    const dir = tempFixtures();
    await writeGoldenReplays(dir);
    for (const path of HAND_WRITTEN_REPLAYS) {
      copyFileSync(onDisk(FIXTURES_DIR, path), onDisk(dir, path));
    }
    writeFileSync(join(dir, REPLAYS_FOLDER, "notes.txt"), "not a replay\n");
    expect(await checkGoldenReplays(dir)).toEqual({ missing: [], changed: [], extra: [] });
  });

  it("is one byte strict: a golden with another line ending is changed", async () => {
    const dir = tempFixtures();
    await writeGoldenReplays(dir);
    const path = goldenReplayPath("single-agent", dir);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    const diff = await checkGoldenReplays(dir);
    expect(diff.changed.map((change) => change.path)).toEqual(["replays/single-agent.replay.json"]);
    expect(diff.changed[0]?.differences[0]).toContain("same data, different bytes");
  });
});

describe("isGoldenReplaysCurrent", () => {
  it("is true only when all three lists are empty", () => {
    expect(isGoldenReplaysCurrent({ missing: [], changed: [], extra: [] })).toBe(true);
    expect(isGoldenReplaysCurrent({ missing: ["a"], changed: [], extra: [] })).toBe(false);
    expect(
      isGoldenReplaysCurrent({ missing: [], changed: [{ path: "a", differences: [] }], extra: [] }),
    ).toBe(false);
    expect(isGoldenReplaysCurrent({ missing: [], changed: [], extra: ["a"] })).toBe(false);
  });
});

describe("describeGoldenReplayDiff", () => {
  it("returns nothing for an empty diff", () => {
    expect(describeGoldenReplayDiff({ missing: [], changed: [], extra: [] })).toEqual([]);
  });

  it("writes one line per file, and the differences of a changed file under it", () => {
    expect(
      describeGoldenReplayDiff({
        missing: ["replays/a.replay.json"],
        changed: [
          {
            path: "replays/b.replay.json",
            differences: ["totals.replies: committed 1, regenerated 2"],
          },
          { path: "replays/c.replay.json", differences: ["first", "second"] },
        ],
        extra: ["replays/d.replay.json"],
      }),
    ).toEqual([
      "missing: replays/a.replay.json",
      "changed: replays/b.replay.json",
      "  totals.replies: committed 1, regenerated 2",
      "changed: replays/c.replay.json",
      "  first",
      "  second",
      "not a golden: replays/d.replay.json",
    ]);
  });
});

describe("golden replay paths", () => {
  it("are named after the scenario and sit in the replays folder", () => {
    expect(GOLDEN_REPLAYS_DIR).toBe(join(FIXTURES_DIR, "replays"));
    for (const name of SCENARIO_NAMES) {
      expect(goldenReplayFile(name)).toBe(`replays/${name}.replay.json`);
      expect(goldenReplayPath(name)).toBe(join(GOLDEN_REPLAYS_DIR, `${name}.replay.json`));
      expect(dirname(goldenReplayPath(name))).toBe(GOLDEN_REPLAYS_DIR);
    }
    const files = SCENARIO_NAMES.map(goldenReplayFile);
    expect(new Set(files).size).toBe(files.length);
    // A golden never takes the name of the hand-written example.
    expect(files.filter((file) => HAND_WRITTEN_REPLAYS.includes(file))).toEqual([]);
    expect(HAND_WRITTEN_REPLAYS).toEqual(["replays/minimal.replay.json"]);
    expect(HAND_WRITTEN_REPLAYS.every((path) => existsSync(onDisk(FIXTURES_DIR, path)))).toBe(true);
  });

  it("resolve against another fixtures folder", () => {
    const dir = makeTempDir();
    expect(goldenReplayPath("demo", dir)).toBe(join(dir, "replays", "demo.replay.json"));
    expect(goldenReplayPath("demo", dir).startsWith(join(dir, CONFIG_FOLDER))).toBe(false);
  });
});
