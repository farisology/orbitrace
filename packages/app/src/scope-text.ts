/**
 * The text alternative of the orrery: one row per agent with what the canvas shows at the
 * playhead. Pure functions over a replay.
 *
 * The rows change only at a few moments (an agent starts or ends, a call starts or its result
 * arrives). `scopeChangeTimes` lists those moments, so the table can re-render when the playhead
 * crosses one instead of on every frame. Every comparison below has the form `moment <= t`, so
 * the rows are the same for every `t` between two consecutive moments.
 */

import type { ReplayAgentId, ReplayModel } from "@orbitrace/core";
import { agentPhase, familyLabel, familyShape, findAgent, type AgentPhase } from "./agent-stats";

export interface ScopeRow {
  readonly id: ReplayAgentId;
  readonly callsign: string;
  /** `Opus (hexagon)`: the family and the shape the canvas draws for it. */
  readonly family: string;
  /** Callsign of the agent that started this one, or `null` for the main agent. */
  readonly parent: string | null;
  readonly phase: AgentPhase;
  /** Tool calls started at or before the playhead. */
  readonly calls: number;
  /** Calls whose failed result arrived at or before the playhead. */
  readonly failed: number;
  /** Calls started and not finished at the playhead. */
  readonly running: number;
  readonly selected: boolean;
}

/** Display text of each phase, as the inspector shows it. */
export const SCOPE_PHASE_LABELS: Readonly<Record<AgentPhase, string>> = {
  waiting: "Not started",
  running: "Running",
  finished: "Finished",
};

/**
 * Sorted, distinct moments at which a row of `scopeRows` can change: agent starts and ends,
 * call starts and call ends.
 */
export function scopeChangeTimes(model: ReplayModel): readonly number[] {
  const times = new Set<number>();
  for (const agent of model.agents) {
    times.add(agent.start);
    if (agent.end !== null) times.add(agent.end);
    for (const tool of agent.tools) {
      times.add(tool.start);
      if (tool.end !== null) times.add(tool.end);
    }
  }
  return [...times].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

/** One row per agent, in model order, for compressed time `t`. */
export function scopeRows(
  model: ReplayModel,
  t: number,
  selected: ReplayAgentId | null,
): readonly ScopeRow[] {
  return model.agents.map((agent) => {
    let calls = 0;
    let failed = 0;
    let running = 0;
    for (const tool of agent.tools) {
      if (tool.start > t) continue;
      calls += 1;
      const done = tool.end !== null && tool.end <= t;
      if (!done) running += 1;
      else if (tool.failed) failed += 1;
    }
    const parent = agent.parent === null ? undefined : findAgent(model, agent.parent);
    return {
      id: agent.id,
      callsign: agent.callsign,
      family: `${familyLabel(agent.family)} (${familyShape(agent.family)})`,
      parent: parent === undefined ? null : parent.callsign,
      phase: agentPhase(agent, t),
      calls,
      failed,
      running,
      selected: agent.id === selected,
    };
  });
}

/** `3 running, 1 finished, 2 not started`: the phase counts, for the table caption. */
export function scopeSummary(rows: readonly ScopeRow[]): string {
  const count = (phase: AgentPhase) => rows.filter((row) => row.phase === phase).length;
  return `${count("running")} running, ${count("finished")} finished, ${count("waiting")} not started`;
}
