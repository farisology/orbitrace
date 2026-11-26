import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import minimal from "../../../fixtures/replays/minimal.replay.json" with { type: "json" };
import schema from "../schema/replay-v1.schema.json" with { type: "json" };
import {
  REPLAY_BUILD_DEFAULTS,
  FORBIDDEN_REPLAY_KEYS,
  KNOWN_MODEL_FAMILIES,
  REPLAY_FORMAT_VERSION,
  TOOL_KINDS,
  type ReplayAgent,
  type ReplayModel,
  type ReplayTotals,
} from "../src/index.js";

// strictTuples is off because `agents` is an open tuple on purpose: `prefixItems` fixes the
// main agent first and `items` allows any number of subagents after it.
const ajv = new Ajv2020({
  strict: true,
  strictTuples: false,
  allowUnionTypes: true,
  allErrors: true,
});
const validate = ajv.compile(schema);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A deep copy that a test can change freely. */
function copy(): { [key: string]: Json } {
  return JSON.parse(JSON.stringify(minimal)) as { [key: string]: Json };
}

function asObject(value: Json | undefined): { [key: string]: Json } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value;
}

function asArray(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

function agentAt(model: { [key: string]: Json }, index: number): { [key: string]: Json } {
  return asObject(asArray(model.agents)[index]);
}

/** Every object node of the schema, with its JSON pointer. */
function schemaObjects(node: unknown, pointer = "#"): { pointer: string; node: object }[] {
  if (node === null || typeof node !== "object") return [];
  const found: { pointer: string; node: object }[] = [{ pointer, node }];
  for (const [key, child] of Object.entries(node)) {
    found.push(...schemaObjects(child, `${pointer}/${key}`));
  }
  return found;
}

describe("replay v1 schema", () => {
  it("accepts the minimal synthetic fixture", () => {
    const ok = validate(minimal);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("sets additionalProperties false on every object schema", () => {
    const objectSchemas = schemaObjects(schema).filter(
      ({ node }) => (node as { type?: unknown }).type === "object",
    );
    expect(objectSchemas.length).toBeGreaterThan(0);
    for (const { pointer, node } of objectSchemas) {
      expect({
        pointer,
        additionalProperties: (node as Record<string, unknown>).additionalProperties,
      }).toEqual({ pointer, additionalProperties: false });
    }
  });

  it("declares none of the forbidden property names", () => {
    const declared = new Set<string>();
    for (const { node } of schemaObjects(schema)) {
      const properties = (node as { properties?: Record<string, unknown> }).properties;
      if (properties) for (const name of Object.keys(properties)) declared.add(name);
    }
    for (const key of FORBIDDEN_REPLAY_KEYS) expect(declared.has(key)).toBe(false);
  });

  it("rejects an extra text field at the top level", () => {
    const model = copy();
    model.text = "an invented sentence";
    expect(validate(model)).toBe(false);
  });

  it("rejects an extra text field on an agent", () => {
    const model = copy();
    agentAt(model, 1).text = "an invented sentence";
    expect(validate(model)).toBe(false);
  });

  it("rejects an extra text field on a tool call, a reply, a warp and the totals", () => {
    const places: ((model: { [key: string]: Json }) => { [key: string]: Json })[] = [
      (model) => asObject(asArray(agentAt(model, 0).tools)[0]),
      (model) => asObject(asArray(agentAt(model, 0).replies)[0]),
      (model) => asObject(asArray(model.warps)[0]),
      (model) => asObject(model.totals),
      (model) => asObject(agentAt(model, 2).totals),
    ];
    for (const place of places) {
      const model = copy();
      place(model).text = "an invented sentence";
      expect(validate(model)).toBe(false);
    }
  });

  it("rejects every forbidden key on a subagent and on a tool call", () => {
    for (const key of FORBIDDEN_REPLAY_KEYS) {
      const onAgent = copy();
      agentAt(onAgent, 3)[key] = "x";
      expect(validate(onAgent)).toBe(false);

      const onTool = copy();
      asObject(asArray(agentAt(onTool, 3).tools)[0])[key] = "x";
      expect(validate(onTool)).toBe(false);
    }
  });

  it("rejects free text in identifier fields", () => {
    const withSpaces = copy();
    agentAt(withSpaces, 1).name = "review the invented module";
    expect(validate(withSpaces)).toBe(false);

    const rawMcp = copy();
    asObject(asArray(agentAt(rawMcp, 0).tools)[3]).name = "mcp__docs__search";
    expect(validate(rawMcp)).toBe(false);

    const runtimeAgentId = copy();
    agentAt(runtimeAgentId, 1).id = "a0f3c9e1";
    expect(validate(runtimeAgentId)).toBe(false);
  });

  it("requires the main agent first and no other agent without a parent", () => {
    const subFirst = copy();
    const agents = asArray(subFirst.agents);
    [agents[0], agents[1]] = [agents[1] as Json, agents[0] as Json];
    expect(validate(subFirst)).toBe(false);

    const orphan = copy();
    agentAt(orphan, 2).parent = null;
    expect(validate(orphan)).toBe(false);
  });

  it("lists the same tool kinds as TOOL_KINDS", () => {
    expect(schema.$defs.toolKind.enum).toEqual([...TOOL_KINDS]);
  });

  it("requires a tool kind from the closed set", () => {
    const missing = copy();
    delete asObject(asArray(agentAt(missing, 0).tools)[0]).kind;
    expect(validate(missing)).toBe(false);

    for (const kind of ["Bash", "write", "", "unknown"]) {
      const wrong = copy();
      asObject(asArray(agentAt(wrong, 0).tools)[0]).kind = kind;
      expect({ kind, ok: validate(wrong) }).toEqual({ kind, ok: false });
    }

    for (const kind of TOOL_KINDS.filter((k) => k !== "mcp")) {
      const ok = copy();
      asObject(asArray(agentAt(ok, 0).tools)[0]).kind = kind;
      expect({ kind, ok: validate(ok) }).toEqual({ kind, ok: true });
    }
  });

  it("accepts tool names from another runtime, sorted by kind", () => {
    const model = copy();
    const tools = asArray(agentAt(model, 3).tools);
    asObject(tools[0]).name = "shell";
    asObject(tools[1]).name = "apply_patch";
    asObject(tools[1]).kind = "edit";
    asObject(tools[2]).name = "spawn_agent";
    asObject(tools[2]).kind = "agent";
    expect(validate(model)).toBe(true);
  });

  it("ties kind mcp to an mcp:<server> name", () => {
    const mcpNameOtherKind = copy();
    asObject(asArray(agentAt(mcpNameOtherKind, 0).tools)[3]).kind = "read";
    expect(validate(mcpNameOtherKind)).toBe(false);

    const plainNameMcpKind = copy();
    asObject(asArray(agentAt(plainNameMcpKind, 0).tools)[0]).kind = "mcp";
    expect(validate(plainNameMcpKind)).toBe(false);
  });

  it("accepts any lower-case family identifier, known or not", () => {
    for (const family of [...KNOWN_MODEL_FAMILIES, "gpt", "nova-2", "x"]) {
      const model = copy();
      agentAt(model, 2).family = family;
      expect({ family, ok: validate(model) }).toEqual({ family, ok: true });
    }
  });

  it("rejects a family that is not an identifier", () => {
    const bad = ["", "Opus", "an invented sentence", "2x", "-opus", "a".repeat(33), null, 4];
    for (const family of bad) {
      const model = copy();
      agentAt(model, 2).family = family;
      expect({ family, ok: validate(model) }).toEqual({ family, ok: false });
    }
  });

  it("rejects another format version", () => {
    const model = copy();
    model.formatVersion = 2;
    expect(validate(model)).toBe(false);
  });
});

describe("minimal fixture", () => {
  const model = minimal as unknown as ReplayModel;
  const subagents = model.agents.slice(1) as ReplayAgent[];

  const sum = (agent: ReplayAgent): ReplayTotals => ({
    toolCalls: agent.tools.length,
    failedToolCalls: agent.tools.filter((tool) => tool.failed).length,
    replies: agent.replies.length,
    inputTokens: agent.replies.reduce((total, reply) => total + reply.inputTokens, 0),
    outputTokens: agent.replies.reduce((total, reply) => total + reply.outputTokens, 0),
    cacheReadTokens: agent.replies.reduce((total, reply) => total + reply.cacheReadTokens, 0),
    cacheCreationTokens: agent.replies.reduce(
      (total, reply) => total + reply.cacheCreationTokens,
      0,
    ),
  });

  it("has the shape the ticket asks for", () => {
    expect(model.formatVersion).toBe(REPLAY_FORMAT_VERSION);
    expect(new Set(subagents.map((agent) => agent.wave))).toEqual(new Set([0, 1]));
    const failed = model.agents.flatMap((agent) => agent.tools.filter((tool) => tool.failed));
    expect(failed).toHaveLength(1);
    expect(model.warps).toHaveLength(1);
  });

  it("keeps per-agent totals equal to the sums of its calls and replies", () => {
    for (const agent of model.agents) expect(agent.totals).toEqual(sum(agent));
  });

  it("keeps session totals equal to the sums over agents", () => {
    const keys = Object.keys(model.agents[0].totals) as (keyof ReplayTotals)[];
    for (const key of keys) {
      const total = model.agents.reduce((acc, agent) => acc + agent.totals[key], 0);
      expect({ key, value: model.totals[key] }).toEqual({ key, value: total });
    }
    expect(model.totals.agents).toBe(model.agents.length);
    const lastEnd = Math.max(...model.agents.map((agent) => agent.end ?? 0));
    expect(model.totals.duration).toBe(lastEnd);
    const skipped = model.warps.reduce((acc, warp) => acc + warp.skipped, 0);
    expect(model.totals.realDuration).toBe(model.totals.duration + skipped);
  });

  it("lists subagents in id order, waves by id prefix, and links every parent", () => {
    const ids = new Set<string>(model.agents.map((agent) => agent.id));
    expect(subagents.map((agent) => agent.id)).toEqual(subagents.map((_, i) => `a${i + 1}`));
    let wave = 0;
    let latestStart = -Infinity;
    for (const [i, agent] of subagents.entries()) {
      if (i > 0 && agent.start > latestStart + REPLAY_BUILD_DEFAULTS.waveGapSeconds) wave += 1;
      latestStart = Math.max(latestStart, agent.start);
      expect({ id: agent.id, wave: agent.wave }).toEqual({ id: agent.id, wave });
    }
    for (const agent of subagents) expect(ids.has(String(agent.parent))).toBe(true);
    for (const agent of model.agents) {
      const toolStarts = agent.tools.map((tool) => tool.start);
      expect(toolStarts).toEqual([...toolStarts].sort((a, b) => a - b));
      const backwards = agent.tools.filter((tool) => tool.end !== null && tool.end < tool.start);
      expect(backwards).toEqual([]);
    }
  });

  it("gives every agent a unique callsign", () => {
    const callsigns = model.agents.map((agent) => agent.callsign);
    expect(new Set(callsigns).size).toBe(callsigns.length);
  });
});
