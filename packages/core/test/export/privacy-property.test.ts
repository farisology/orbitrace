/**
 * Ticket #23: property test of the export path. A seeded generator writes hostile synthetic
 * sessions (marker strings in every string field, as keys, as ids, as tool names, agent
 * types, model ids, effort values, versions and line types, with broken timestamps, odd
 * numbers and dangling links) and checks, for each one, what `parseSession` ->
 * `buildReplay` -> `exportReplay` writes. Fixed seeds, so a failure always reproduces.
 */
import { describe, expect, it } from "vitest";
import {
  buildReplay,
  exportReplay,
  parseSession,
  validateReplay,
  type RawSubagentInput,
  type RawSubagentMeta,
  type SessionInput,
} from "../../src/index.js";
import { FREE_TEXT_MARKERS, IDENTIFIER_MARKERS, markerPointers } from "./audit-markers.js";

/** Small seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  constructor(private readonly next: () => number) {}
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  marker(): string {
    return this.chance(0.5) ? this.pick(FREE_TEXT_MARKERS) : this.pick(IDENTIFIER_MARKERS);
  }
}

const TOOL_NAMES = ["Bash", "Read", "Edit", "Write", "Grep", "Agent", "Task", "WebFetch"];
const AGENT_TYPES = ["code-reviewer", "general-purpose", "example-plugin:helper"];
const MODELS = ["claude-opus-5-5", "claude-sonnet-9-0", "claude-haiku-9-0", "<synthetic>"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const LINE_TYPES = ["assistant", "assistant", "assistant", "user", "user", "system", "mode"];

function toolName(g: Gen): string {
  switch (g.int(0, 4)) {
    case 0:
      return g.marker();
    case 1:
      return `mcp__${g.marker()}__lookup`;
    case 2:
      return `mcp__docs__${g.marker()}`;
    case 3:
      return "mcp__docs__search";
    default:
      return g.pick(TOOL_NAMES);
  }
}

function model(g: Gen): string | undefined {
  switch (g.int(0, 4)) {
    case 0:
      return g.marker();
    case 1:
      return `claude-${g.marker()}`;
    case 2:
      return undefined;
    default:
      return g.pick(MODELS);
  }
}

/** A value of any JSON type, often holding a marker, sometimes nested. */
function junk(g: Gen, depth = 0): unknown {
  switch (g.int(0, depth > 1 ? 3 : 5)) {
    case 0:
      return g.marker();
    case 1:
      return g.int(-5, 1e9);
    case 2:
      return g.chance(0.5);
    case 3:
      return null;
    case 4:
      return [junk(g, depth + 1), g.marker()];
    default:
      return { [g.marker()]: junk(g, depth + 1), text: g.marker() };
  }
}

interface Ids {
  tools: string[];
  messages: string[];
}

function timestamp(g: Gen, base: number, index: number): unknown {
  if (g.chance(0.05)) return g.marker();
  if (g.chance(0.05)) return undefined;
  return new Date(base + index * g.int(0, 90_000) + g.int(0, 999)).toISOString();
}

function line(g: Gen, ids: Ids, base: number, index: number): string {
  const type = g.chance(0.08) ? g.marker() : g.pick(LINE_TYPES);
  const record: Record<string, unknown> = {
    type,
    timestamp: timestamp(g, base, index),
    uuid: g.chance(0.3) ? g.marker() : `u-${index}`,
    sessionId: g.marker(),
    cwd: g.marker(),
    gitBranch: g.marker(),
    version: g.marker(),
    [g.marker()]: junk(g),
  };
  if (type === "assistant") {
    const messageId = g.chance(0.4) && ids.messages.length > 0 ? g.pick(ids.messages) : g.marker();
    ids.messages.push(messageId);
    const content: unknown[] = [{ type: "text", text: g.marker() }];
    for (let i = g.int(0, 3); i > 0; i -= 1) {
      const id = g.chance(0.2) ? g.marker() : `t-${index}-${i}`;
      ids.tools.push(id);
      content.push({ type: "tool_use", id, name: toolName(g), input: junk(g) });
    }
    record["effort"] = g.chance(0.5) ? g.pick(EFFORTS) : g.marker();
    record["message"] = {
      id: messageId,
      model: model(g),
      role: g.marker(),
      usage: {
        input_tokens: g.chance(0.1) ? g.marker() : g.int(-10, 5e6),
        output_tokens: g.int(0, 5e4),
        cache_read_input_tokens: g.chance(0.1) ? -1 : g.int(0, 1e6),
        cache_creation_input_tokens: g.int(0, 1e5),
        [g.marker()]: g.marker(),
      },
      content,
    };
  } else if (type === "user") {
    const content: unknown[] = [{ type: "text", text: g.marker() }];
    for (let i = g.int(0, 2); i > 0 && ids.tools.length > 0; i -= 1) {
      content.push({
        type: "tool_result",
        tool_use_id: g.chance(0.1) ? g.marker() : g.pick(ids.tools),
        is_error: g.chance(0.3) ? true : g.chance(0.5) ? g.marker() : false,
        content: junk(g),
      });
    }
    record["message"] = { role: "user", content: g.chance(0.2) ? g.marker() : content };
  } else {
    record["detail"] = junk(g);
  }
  return JSON.stringify(record);
}

/** A hostile session from one seed. */
function hostileSession(seed: number): SessionInput {
  const g = new Gen(rng(seed));
  const base = Date.UTC(2031, 2, 3, 4, 5, 6) + g.int(0, 1e9);
  const ids: Ids = { tools: [], messages: [] };
  const main: string[] = [];
  for (let i = g.int(1, 25); i > 0; i -= 1) main.push(line(g, ids, base, main.length));
  if (g.chance(0.2)) main.push("not json " + g.marker());
  const subagents: RawSubagentInput[] = [];
  for (let s = g.int(0, 3); s > 0; s -= 1) {
    const lines: string[] = [];
    for (let i = g.int(0, 12); i > 0; i -= 1) lines.push(line(g, ids, base, lines.length + 5));
    subagents.push({
      agentId: g.chance(0.5) ? g.marker() : `agent-${s}`,
      meta: g.chance(0.15)
        ? null
        : ({
            agentType: g.chance(0.5) ? g.marker() : g.pick(AGENT_TYPES),
            model: model(g),
            description: g.marker(),
            toolUseId: ids.tools.length > 0 && g.chance(0.8) ? g.pick(ids.tools) : g.marker(),
            spawnDepth: g.int(0, 3),
            isBuiltIn: g.chance(0.5),
            finished: g.chance(0.5) ? g.marker() : true,
            [g.marker()]: junk(g),
          } as unknown as RawSubagentMeta),
      lines,
    });
  }
  return { main, subagents };
}

const IDENTS = new Set(IDENTIFIER_MARKERS);

/** Whether a string at `pointer` in `replay` is an allowed, as-written identifier marker. */
function isAllowedName(replay: { agents: Record<string, unknown>[] }, pointer: string): boolean {
  const match = /^\/agents\/(\d+)\/(name|callsign|model|family|tools\/(\d+)\/name)$/.exec(pointer);
  if (match === null) return false;
  const agent = replay.agents[Number(match[1])] as Record<string, unknown>;
  const field = match[2] as string;
  if (field === "name") return IDENTS.has(agent["name"] as string);
  if (field === "callsign") return IDENTS.has((agent["callsign"] as string).replace(/#\d+$/, ""));
  const modelId = agent["model"] as string | null;
  if (field === "model") {
    return modelId !== null && IDENTS.has(modelId.replace(/^claude-/, ""));
  }
  if (field === "family") {
    return modelId !== null && modelId.includes(agent["family"] as string);
  }
  const tools = agent["tools"] as { name: string }[];
  const name = (tools[Number(match[3])] as { name: string }).name;
  return IDENTS.has(name.replace(/^mcp:/, ""));
}

describe("hostile synthetic sessions (seeded property test)", () => {
  it("always exports a valid replay where a marker appears only as an identifier name", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 400; seed += 1) {
      const input = hostileSession(seed);
      let data: string;
      try {
        data = exportReplay(buildReplay(await parseSession(input))).data;
      } catch (error) {
        failures.push(`seed ${seed}: export threw: ${(error as Error).name}`);
        continue;
      }
      const replay = JSON.parse(data) as { agents: Record<string, unknown>[] };
      expect(validateReplay(replay)).toBe(true);
      const bad = markerPointers(replay).filter((pointer) => !isAllowedName(replay, pointer));
      if (bad.length > 0) failures.push(`seed ${seed}: ${bad.join(", ")}`);
      for (const marker of FREE_TEXT_MARKERS) {
        if (data.includes(JSON.stringify(marker).slice(1, -1))) {
          failures.push(`seed ${seed}: free text`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("gives the same bytes for the same input", async () => {
    for (let seed = 1000; seed < 1050; seed += 1) {
      const once = exportReplay(buildReplay(await parseSession(hostileSession(seed)))).data;
      const twice = exportReplay(buildReplay(await parseSession(hostileSession(seed)))).data;
      expect(twice).toBe(once);
    }
  });

  it("produces sessions that reach every branch it means to attack", async () => {
    let subagents = 0;
    let mcp = 0;
    let named = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const replay = buildReplay(await parseSession(hostileSession(seed)));
      subagents += replay.agents.length - 1;
      for (const agent of replay.agents) {
        mcp += agent.tools.filter((tool) => tool.kind === "mcp").length;
        if (markerPointers(agent).length > 0) named += 1;
      }
    }
    expect(subagents).toBeGreaterThan(100);
    expect(mcp).toBeGreaterThan(100);
    expect(named).toBeGreaterThan(50);
  });
});
