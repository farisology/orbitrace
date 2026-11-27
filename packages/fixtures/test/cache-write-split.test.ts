// Tickets #190 and #191: a synthetic session that writes the cache-write split by lifetime and
// changes model within one agent, generated on demand so that the committed fixtures and every
// golden replay stay byte for byte as they were. Every value is invented.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReplay,
  cacheWriteBasis,
  describeReplayModelProblems,
  exportReplay,
  parseSession,
  sessionLedger,
  validateReplay,
  type ParsedSession,
  type SessionInput,
} from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRA_SCENARIOS,
  EXTRA_SCENARIO_NAMES,
  FIXTURES_DIR,
  MODELS,
  SCENARIO_NAMES,
  USAGE_SPLIT_KEY,
  addCacheCreation,
  buildManifest,
  cacheCreationOf,
  generateAll,
  generateExtraSession,
  goldenReplayPath,
  maxCacheCreation,
  readFixtureManifest,
  writeGeneratedSession,
  type BuiltSession,
  type FullCacheCreation,
} from "../src/index.js";
import { isObject, parseJsonl, type JsonObject } from "./helpers.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

const session = generateExtraSession("cache-write-split");

/** The lines of every transcript of a generated session, by agent type (`main` for main). */
function linesByAgent(built: BuiltSession): Map<string, JsonObject[]> {
  const byAgent = new Map<string, JsonObject[]>();
  const content = (path: string) => built.files.find((file) => file.path === path)?.content ?? "";
  byAgent.set("main", parseJsonl(content(built.transcriptPath)));
  for (const sub of built.subagents) {
    byAgent.set(sub.agentType, parseJsonl(content(sub.transcriptPath)));
  }
  return byAgent;
}

function usageOf(line: JsonObject): JsonObject {
  const message = line["message"];
  if (!isObject(message) || !isObject(message["usage"])) throw new Error("no usage");
  return message["usage"];
}

const assistantLines = (lines: readonly JsonObject[]) =>
  lines.filter((line) => line["type"] === "assistant");

/** A generated session as the parser's input, straight from its files in memory. */
function sessionInput(built: BuiltSession): SessionInput {
  const content = (path: string) => built.files.find((file) => file.path === path)?.content ?? "";
  const lines = (path: string) => content(path).split("\n");
  return {
    main: lines(built.transcriptPath),
    subagents: built.subagents.map((sub) => ({
      agentId: sub.agentId,
      meta: sub.meta,
      lines: lines(sub.transcriptPath),
    })),
  };
}

describe("cacheCreationOf and the split helpers", () => {
  it("split a total by lifetime so that the parts add up", () => {
    expect(cacheCreationOf(301, "5m")).toEqual({
      ephemeral_5m_input_tokens: 301,
      ephemeral_1h_input_tokens: 0,
    });
    expect(cacheCreationOf(301, "1h")).toEqual({
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 301,
    });
    expect(cacheCreationOf(301, "half")).toEqual({
      ephemeral_5m_input_tokens: 151,
      ephemeral_1h_input_tokens: 150,
    });
    const a: FullCacheCreation = { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 1 };
    const b: FullCacheCreation = { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 7 };
    expect(maxCacheCreation(a, b)).toEqual({
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 7,
    });
    expect(addCacheCreation(a, b)).toEqual({
      ephemeral_5m_input_tokens: 6,
      ephemeral_1h_input_tokens: 8,
    });
  });
});

describe("the cache-write-split scenario", () => {
  it("is generated on demand only, never with the committed fixtures", () => {
    expect([...EXTRA_SCENARIO_NAMES]).toEqual(["cache-write-split"]);
    for (const name of EXTRA_SCENARIO_NAMES) {
      expect(SCENARIO_NAMES as readonly string[]).not.toContain(name);
      expect(EXTRA_SCENARIOS[name].name).toBe(name);
    }
    const names = generateAll().map((generated) => generated.name as string);
    expect(names).not.toContain("cache-write-split");
    expect(buildManifest(generateAll()).sessions.map((entry) => entry.name)).toEqual([
      ...SCENARIO_NAMES,
    ]);
    expect(readFixtureManifest().sessions.map((entry) => entry.name)).toEqual([...SCENARIO_NAMES]);
    expect(() => generateExtraSession("demo")).toThrow('unknown extra scenario "demo"');
  });

  it("is deterministic and carries its name, seed and project", () => {
    expect(generateExtraSession("cache-write-split")).toEqual(session);
    expect(generateExtraSession("cache-write-split", { seed: "other" }).files).not.toEqual(
      session.files,
    );
    expect(session).toMatchObject({
      name: "cache-write-split",
      project: "lantern-ledger",
      cwd: "/workspace/lantern-ledger",
    });
  });

  it("writes a split that adds up on every line of an agent that has one, and none elsewhere", () => {
    const byAgent = linesByAgent(session);
    const expected: Record<string, "5m" | "1h" | "half" | null> = {
      main: "1h",
      Explore: "5m",
      "lantern-builder": "half",
      "docs-scribe": null,
    };
    const lines = (agent: string) => assistantLines(byAgent.get(agent) ?? []);
    // What each line holds under `cache_creation` (null when the key is missing), and what it
    // should hold given the line's own total, per agent.
    const written = Object.fromEntries(
      Object.keys(expected).map((agent) => [
        agent,
        lines(agent).map((line) => usageOf(line)[USAGE_SPLIT_KEY] ?? null),
      ]),
    );
    const wanted = Object.fromEntries(
      Object.entries(expected).map(([agent, split]) => [
        agent,
        lines(agent).map((line) =>
          split === null
            ? null
            : cacheCreationOf(usageOf(line)["cache_creation_input_tokens"] as number, split),
        ),
      ]),
    );
    expect(written).toEqual(wanted);
    expect(Object.keys(expected).map((agent) => lines(agent).length > 0)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("changes model within the main agent and within one subagent", () => {
    const byAgent = linesByAgent(session);
    const models = (agent: string) =>
      new Set(
        assistantLines(byAgent.get(agent) ?? []).map(
          (line) => (line["message"] as JsonObject)["model"],
        ),
      );
    expect(models("main")).toEqual(new Set([MODELS.opus, MODELS.haiku]));
    expect(models("Explore")).toEqual(new Set([MODELS.haiku, MODELS.sonnet]));
    expect(models("lantern-builder")).toEqual(new Set([MODELS.sonnet]));
    const facts = session.expected.agents;
    expect(facts[0]?.replyModels).toEqual({ [MODELS.opus]: 4, [MODELS.haiku]: 1 });
    expect(facts.find((agent) => agent.agentType === "Explore")?.replyModels).toEqual({
      [MODELS.haiku]: 2,
      [MODELS.sonnet]: 2,
    });
    expect(facts.find((agent) => agent.agentType === "lantern-builder")).not.toHaveProperty(
      "replyModels",
    );
  });

  it("states the split in its facts, per agent and in total", () => {
    const facts = session.expected;
    const docs = facts.agents.find((agent) => agent.agentType === "docs-scribe");
    expect(docs).not.toHaveProperty("cacheCreation");
    let sum: FullCacheCreation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
    const split = facts.agents.filter((agent) => agent.cacheCreation !== undefined);
    expect(split.map((agent) => agent.agentType)).toEqual([null, "Explore", "lantern-builder"]);
    // Every line's split adds up, so each agent's sum adds up to its cache creation total.
    expect(
      split.map(
        (agent) =>
          (agent.cacheCreation?.ephemeral_5m_input_tokens ?? 0) +
          (agent.cacheCreation?.ephemeral_1h_input_tokens ?? 0),
      ),
    ).toEqual(split.map((agent) => agent.usage.cache_creation_input_tokens));
    for (const agent of split) {
      sum = addCacheCreation(sum, agent.cacheCreation as FullCacheCreation);
    }
    expect(facts.totals.cacheCreation).toEqual(sum);
  });
});

describe("the pipeline over the cache-write-split session", () => {
  async function parsed(): Promise<ParsedSession> {
    return parseSession(sessionInput(session));
  }

  it("carries the split and each reply's model into the in-memory model, as the facts say", async () => {
    const model = buildReplay(await parsed(), { replyDetails: true });
    expect(describeReplayModelProblems(model)).toEqual([]);
    // Per agent: the summed split (null when no reply has one) and the replies per model.
    const fromModel = model.agents.map((agent) => {
      const hasSplit = agent.replies.some(
        (entry) => "cacheWrite5mTokens" in entry || "cacheWrite1hTokens" in entry,
      );
      const sum = (key: "cacheWrite5mTokens" | "cacheWrite1hTokens") =>
        agent.replies.reduce((acc, entry) => acc + (entry[key] ?? 0), 0);
      const models: Record<string, number> = {};
      for (const entry of agent.replies) {
        models[String(entry.model)] = (models[String(entry.model)] ?? 0) + 1;
      }
      return {
        name: agent.name,
        split: hasSplit
          ? {
              ephemeral_5m_input_tokens: sum("cacheWrite5mTokens"),
              ephemeral_1h_input_tokens: sum("cacheWrite1hTokens"),
            }
          : null,
        models,
      };
    });
    const fromFacts = model.agents.map((agent) => {
      const facts =
        agent.id === "main"
          ? session.expected.agents[0]
          : session.expected.agents.find((entry) => entry.agentType === agent.name);
      return {
        name: agent.name,
        split: facts?.cacheCreation ?? null,
        models: facts?.replyModels ?? { [facts?.model ?? ""]: agent.replies.length },
      };
    });
    expect(fromModel).toEqual(fromFacts);
    expect(fromModel.map((entry) => entry.split === null)).toEqual([false, false, false, true]);
  });

  it("exports the same bytes with and without the details", async () => {
    const session1 = await parsed();
    const detailed = buildReplay(session1, { replyDetails: true });
    const plain = buildReplay(session1);
    expect(validateReplay(plain)).toBe(true);
    expect(exportReplay(detailed, { pretty: true }).data).toBe(
      exportReplay(plain, { pretty: true }).data,
    );
  });

  it("gives the ledger a mixed cache-write basis and a reply-level model split", async () => {
    const ledger = sessionLedger(buildReplay(await parsed(), { replyDetails: true }));
    expect(cacheWriteBasis(ledger.session)).toBe("mixed");
    expect(ledger.session.ownModelReplies).toBe(ledger.session.replies);
    expect(ledger.byModel.map((entry) => entry.model)).toEqual(
      expect.arrayContaining([MODELS.opus, MODELS.haiku, MODELS.sonnet]),
    );
    expect(ledger.session.pricing).toBe("priced");
    const writes = ledger.session.cacheWrites;
    expect(writes.recorded5m + writes.recorded1h + writes.unrecorded - writes.overTotal).toBe(
      ledger.session.tokens.cacheCreation,
    );
  });

  it("can be written to a temporary config folder and found by the source adapter", async () => {
    const configDir = makeTempDir();
    const written = writeGeneratedSession(configDir, session);
    expect(written).toHaveLength(session.files.length);
    const refs = await claudeCodeAdapter.listSessions({
      runtime: claudeCodeAdapter.runtime,
      root: configDir,
      resolvedBy: "user-setting",
      available: true,
    });
    expect(refs.map((ref) => ref.sessionId)).toEqual([session.sessionId]);
    const fromDisk = await parseSession(await claudeCodeAdapter.openSession(refs[0]!));
    expect(buildReplay(fromDisk, { replyDetails: true })).toEqual(
      buildReplay(await parsed(), { replyDetails: true }),
    );
  });
});

describe("the committed fixtures with replyDetails", () => {
  it("write no split, and export exactly the committed golden bytes", async () => {
    const manifest = readFixtureManifest();
    const refs = await claudeCodeAdapter.listSessions({
      runtime: claudeCodeAdapter.runtime,
      root: join(FIXTURES_DIR, "config"),
      resolvedBy: "user-setting",
      available: true,
    });
    const results: { name: string; split: boolean; same: boolean }[] = [];
    for (const entry of manifest.sessions) {
      const ref = refs.find((candidate) => candidate.sessionId === entry.sessionId);
      if (ref === undefined) throw new Error(`no transcript for session ${entry.name}`);
      const parsedSession = await parseSession(await claudeCodeAdapter.openSession(ref));
      const model = buildReplay(parsedSession, { replyDetails: true });
      const golden = readFileSync(goldenReplayPath(entry.name), "utf8");
      results.push({
        name: entry.name,
        split: model.agents.some((agent) =>
          agent.replies.some((reply) => "cacheWrite5mTokens" in reply),
        ),
        same: exportReplay(model, { pretty: true }).data === golden,
      });
    }
    expect(results).toEqual(
      manifest.sessions.map((entry) => ({ name: entry.name, split: false, same: true })),
    );
  });
});
