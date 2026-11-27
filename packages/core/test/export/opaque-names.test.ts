// Ticket #122: the `names: "opaque"` export option, unit by unit. All names are invented.
import { describe, expect, it } from "vitest";
import {
  isKnownModelId,
  OPAQUE_AGENT_PREFIX,
  OPAQUE_KEPT_TOOL_NAMES,
  OPAQUE_MCP_PREFIX,
  OPAQUE_TOOL_PREFIX,
  opaqueNames,
  validateReplay,
  type ReplayModel,
  type ReplaySubagent,
  type ReplayToolCall,
} from "../../src/index.js";
import { makeModel, mutableCopy } from "./model.js";

function tool(name: string, kind: ReplayToolCall["kind"], start: number): ReplayToolCall {
  return { name, kind, start, end: start + 1, failed: false };
}

/** makeModel with invented private-looking names in every name field. */
function namedModel(): ReplayModel {
  const base = makeModel();
  const [main, first, second] = base.agents as unknown as [
    ReplayModel["agents"][0],
    ReplaySubagent,
    ReplaySubagent,
  ];
  const third: ReplaySubagent = {
    ...first,
    id: "a3",
    name: "example-plugin:helper",
    callsign: "example-plugin:helper",
    model: "example-custom-model-7",
    family: "unknown",
    start: 100,
    end: 110,
    tools: [
      tool("mcp:example-docs", "mcp", 101),
      tool("mcp:example-tracker", "mcp", 102),
      tool("ExampleCustomTool", "other", 103),
      tool("mcp:unknown", "mcp", 104),
      tool("unknown", "other", 105),
    ],
    replies: [],
    totals: { ...first.totals, toolCalls: 5, failedToolCalls: 0, replies: 0 },
  };
  const firstTools = [...first.tools, tool("ExampleCustomTool", "other", 21)];
  return {
    ...base,
    agents: [
      { ...main, model: "claude-quartz-1-0", family: "quartz" },
      {
        ...first,
        tools: firstTools,
        totals: { ...first.totals, toolCalls: firstTools.length },
      },
      second,
      third,
    ],
    totals: { ...base.totals, agents: 4, toolCalls: base.totals.toolCalls + 6 },
  };
}

describe("isKnownModelId", () => {
  it("keeps Claude ids with a known family and bare family aliases", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-9-1",
      "claude-haiku-5-5-20260115",
      "claude-fable-5-2",
      "claude-3-5-sonnet-20241022",
      "claude-3-haiku-latest",
      "opus",
      "sonnet",
    ]) {
      expect(isKnownModelId(id)).toBe(true);
    }
  });

  it("refuses custom ids, unknown families and ids with extra words", () => {
    for (const id of [
      "claude-quartz-1-0",
      "claude-opus-5-5-example-client",
      "claude-example-1",
      "example-custom-model-7",
      "claude-opus",
      "unknown",
      "gpt-example-4",
      "claude-opus-5-5-5-5",
    ]) {
      expect(isKnownModelId(id)).toBe(false);
    }
  });
});

describe("OPAQUE_KEPT_TOOL_NAMES", () => {
  it("holds the parser's built-ins and the builder's fixed labels, and no label shape", () => {
    for (const name of ["Bash", "Read", "Grep", "Glob", "Edit", "Write", "Agent", "Task"]) {
      expect(OPAQUE_KEPT_TOOL_NAMES).toContain(name);
    }
    expect(OPAQUE_KEPT_TOOL_NAMES).toContain("SubagentHandback");
    expect(OPAQUE_KEPT_TOOL_NAMES).toContain("unknown");
    expect(OPAQUE_KEPT_TOOL_NAMES).toContain("mcp");
    for (const name of OPAQUE_KEPT_TOOL_NAMES) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
      expect(name.startsWith(OPAQUE_TOOL_PREFIX)).toBe(false);
    }
  });
});

describe("opaqueNames", () => {
  it("replaces agent types, MCP servers, custom tools and unknown models with labels", () => {
    const input = namedModel();
    const output = opaqueNames(input);
    const [main, a1, a2, a3] = output.agents;

    expect(main.name).toBe("main");
    expect(main.callsign).toBe("main");
    expect(main.model).toBeNull();
    expect(main.family).toBe("unknown");
    expect(main.tools.map((t) => t.name)).toEqual(["Read", "Agent", "mcp:server-1", "Agent"]);

    expect([a1?.name, a1?.callsign]).toEqual(["agent-1", "agent-1"]);
    expect([a2?.name, a2?.callsign]).toEqual(["agent-1", "agent-1#2"]);
    expect([a3?.name, a3?.callsign]).toEqual(["agent-2", "agent-2"]);

    expect(a1?.model).toBe("claude-sonnet-9-1");
    expect(a1?.family).toBe("sonnet");
    expect(a3?.model).toBeNull();
    expect(a3?.family).toBe("unknown");

    expect(a1?.tools.map((t) => t.name)).toEqual(["Grep", "Edit", "tool_1"]);
    expect(a3?.tools.map((t) => t.name)).toEqual([
      "mcp:server-1",
      "mcp:server-2",
      "tool_1",
      "mcp:unknown",
      "unknown",
    ]);
    expect(validateReplay(JSON.parse(JSON.stringify(output)))).toBe(true);
  });

  it("uses the documented label prefixes", () => {
    expect([OPAQUE_AGENT_PREFIX, OPAQUE_MCP_PREFIX, OPAQUE_TOOL_PREFIX]).toEqual([
      "agent-",
      "mcp:server-",
      "tool_",
    ]);
  });

  it("changes nothing else and leaves the input as it was", () => {
    const input = namedModel();
    const before = JSON.stringify(input);
    const output = opaqueNames(input);
    expect(JSON.stringify(input)).toBe(before);

    const strip = (model: ReplayModel): unknown =>
      JSON.parse(JSON.stringify(model), (key, value: unknown) =>
        ["name", "callsign", "model", "family"].includes(key) ? "-" : value,
      );
    expect(strip(output)).toEqual(strip(input));
    // Same key order, so the serialised form differs only in the names.
    const keys = (model: ReplayModel): string =>
      JSON.stringify(model).replace(/"(name|callsign|model|family)":(null|"[^"]*")/g, "");
    expect(keys(output)).toBe(keys(input));
  });

  it("gives the same labels for the same replay, and numbers by first appearance", () => {
    expect(JSON.stringify(opaqueNames(namedModel()))).toBe(
      JSON.stringify(opaqueNames(namedModel())),
    );
    // Swap which name comes first: the numbering follows the order, not the name.
    const swapped = mutableCopy(namedModel());
    const agents = swapped.agents as Record<string, unknown>[];
    const a1 = agents[1] as Record<string, unknown>;
    const a3 = agents[3] as Record<string, unknown>;
    [a1.name, a3.name] = [a3.name, a1.name];
    a1.callsign = a1.name;
    a3.callsign = a3.name;
    const out = opaqueNames(swapped as unknown as ReplayModel);
    expect(out.agents.map((agent) => agent.callsign)).toEqual([
      "main",
      "agent-1",
      "agent-2#2",
      "agent-2",
    ]);
  });

  it("numbers callsigns again when one is not formed from its name", () => {
    const odd = mutableCopy(namedModel());
    const agents = odd.agents as Record<string, unknown>[];
    (agents[2] as Record<string, unknown>).callsign = "something-else";
    const out = opaqueNames(odd as unknown as ReplayModel);
    expect(out.agents.map((agent) => agent.callsign)).toEqual([
      "main",
      "agent-1#1",
      "agent-1#2",
      "agent-2",
    ]);
    expect(validateReplay(JSON.parse(JSON.stringify(out)))).toBe(true);
  });

  it("leaves a replay with only built-in names and known models unchanged", () => {
    const model = makeModel();
    const plain = mutableCopy(model);
    const agents = plain.agents as Record<string, unknown>[];
    // makeModel's only chosen names: one agent type and one MCP server.
    for (const agent of agents.slice(1)) {
      agent.name = "agent-1";
      agent.callsign = (agent.callsign as string).replace("widget-reviewer", "agent-1");
    }
    const tools = (agents[0] as { tools: { name: string }[] }).tools;
    for (const t of tools) if (t.name === "mcp:example-docs") t.name = "mcp:server-1";
    expect(JSON.parse(JSON.stringify(opaqueNames(model)))).toEqual(plain);
  });
});
