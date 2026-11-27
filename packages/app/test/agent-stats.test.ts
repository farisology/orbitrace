import { agentPhase as coreAgentPhase } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import {
  KIND_LABELS,
  agentPhase,
  callsigns,
  familyLabel,
  familyShape,
  findAgent,
  isAgentId,
  toolCallsByKind,
  waveLabel,
} from "../src/agent-stats";
import { DEMO, makeModel } from "./helpers";

describe("agent stats", () => {
  const model = makeModel();
  const [main, a1, a2] = model.agents;

  it("counts tool calls by kind with failures, in kind order", () => {
    expect(toolCallsByKind(main)).toEqual([
      { kind: "shell", calls: 1, failed: 1 },
      { kind: "read", calls: 1, failed: 0 },
      { kind: "edit", calls: 1, failed: 0 },
      { kind: "agent", calls: 2, failed: 0 },
    ]);
    expect(toolCallsByKind(a2!)).toEqual([
      { kind: "edit", calls: 1, failed: 0 },
      { kind: "mcp", calls: 1, failed: 0 },
    ]);
    expect(Object.keys(KIND_LABELS)).toHaveLength(6);
  });

  it("agrees with the totals of every agent in the demo golden", () => {
    for (const agent of DEMO.agents) {
      const kinds = toolCallsByKind(agent);
      expect(kinds.reduce((s, k) => s + k.calls, 0)).toBe(agent.totals.toolCalls);
      expect(kinds.reduce((s, k) => s + k.failed, 0)).toBe(agent.totals.failedToolCalls);
    }
  });

  it("tells the phase of an agent at a time", () => {
    expect(agentPhase(a1!, 1)).toBe("waiting");
    expect(agentPhase(a1!, 4)).toBe("running");
    expect(agentPhase(a1!, 20)).toBe("finished");
    expect(agentPhase(a2!, 1000)).toBe("running");
  });

  it("uses core's phase rule, so it agrees with the renderer at the boundary instants (#108)", () => {
    expect(agentPhase).toBe(coreAgentPhase);
    for (const agent of DEMO.agents) {
      const end = agent.end!;
      expect(agentPhase(agent, agent.start - 0.001)).toBe("waiting");
      expect(agentPhase(agent, agent.start)).toBe("running");
      expect(agentPhase(agent, end - 0.001)).toBe("running");
      expect(agentPhase(agent, end)).toBe("finished");
    }
    // The last frame of playback: the clock stops at the main agent's end, which is finished.
    expect(agentPhase(DEMO.agents[0], DEMO.totals.duration)).toBe("finished");
  });

  it("labels families, shapes and waves", () => {
    expect(familyLabel("opus")).toBe("Opus");
    expect(familyLabel("future-model")).toBe("Future-model");
    expect(familyShape("fable")).toBe("burst");
    expect(familyShape("opus")).toBe("hexagon");
    expect(familyShape("sonnet")).toBe("diamond");
    expect(familyShape("haiku")).toBe("triangle");
    expect(familyShape("unknown")).toBe("circle");
    expect(familyShape("future-model")).toBe("circle");
    expect(familyShape("constructor")).toBe("circle");
    expect(waveLabel(null)).toBe("centre");
    expect(waveLabel(0)).toBe("Wave 1");
  });

  it("finds agents and callsigns by id", () => {
    expect(findAgent(model, "a1")?.callsign).toBe("widget-explorer");
    expect(findAgent(model, "a9")).toBeUndefined();
    expect(findAgent(model, null)).toBeUndefined();
    expect(callsigns(model).get("a2")).toBe("gadget-builder");
  });

  it("recognises agent ids", () => {
    expect(isAgentId("main")).toBe(true);
    expect(isAgentId("a12")).toBe(true);
    expect(isAgentId("a0")).toBe(false);
    expect(isAgentId("a")).toBe(false);
    expect(isAgentId("main2")).toBe(false);
  });
});
