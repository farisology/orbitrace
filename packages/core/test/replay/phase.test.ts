import { describe, expect, it } from "vitest";
import { AGENT_PHASES, agentPhase, type AgentPhase } from "../../src/index.js";

/**
 * The boundary table of #108. The app's inspector and the renderer both call this function;
 * their tests check the boundary instants again through their own entry points.
 */
const PHASE_CASES: readonly (readonly [number, number | null, number, AgentPhase])[] = [
  [10, 20, 0, "waiting"],
  [10, 20, 9.999, "waiting"],
  [10, 20, 10, "running"],
  [10, 20, 15, "running"],
  [10, 20, 19.999, "running"],
  [10, 20, 20, "finished"],
  [10, 20, 20.001, "finished"],
  [10, 10, 10, "finished"],
  [10, null, 10, "running"],
  [10, null, 1e9, "running"],
  [0, 0, 0, "finished"],
];

describe("agentPhase", () => {
  it.each(PHASE_CASES)("start %s, end %s, at %s: %s", (start, end, t, phase) => {
    expect(agentPhase({ start, end }, t)).toBe(phase);
  });

  it("treats an end of Infinity like null (the renderer's encoding of a running agent)", () => {
    expect(agentPhase({ start: 0, end: Infinity }, 1e12)).toBe("running");
  });

  it("is half-open: finished at the end instant, as the main agent is on the last frame", () => {
    const main = { start: 0, end: 535.07 };
    expect(agentPhase(main, 535.07)).toBe("finished");
    expect(agentPhase(main, 535.069)).toBe("running");
  });

  it("lists the phases in the order an agent goes through them", () => {
    expect(AGENT_PHASES).toEqual(["waiting", "running", "finished"]);
  });
});
