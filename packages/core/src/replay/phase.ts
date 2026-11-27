/**
 * The phase of an agent at a replay time: one rule for every consumer (#108). The renderer
 * draws with it and the app's inspector labels with it, so the canvas and the panels never
 * disagree at an agent's start or end.
 *
 * The span is half-open, `[start, end)`: an agent is running from its `start` up to, but not
 * at, its `end`, and finished from `end` on. This matches the replay model, where `end` is the
 * time of the agent's last line: at that instant the agent has nothing left to do. An `end` of
 * `null` (still running in a live snapshot) or `Infinity` (the renderer's encoding of `null`)
 * never finishes.
 *
 * Browser-safe and allocation-free: it returns one of three interned strings, so the renderer
 * may call it on every frame.
 */

import type { ReplaySeconds } from "../model/replay.js";

/** The phases, in the order an agent goes through them. */
export const AGENT_PHASES = ["waiting", "running", "finished"] as const;

/** `waiting` before `start`, `running` in `[start, end)`, `finished` from `end` on. */
export type AgentPhase = (typeof AGENT_PHASES)[number];

/** What `agentPhase` reads from an agent: a `ReplayAgent` fits, and so does any `{ start, end }`. */
export interface AgentSpan {
  readonly start: ReplaySeconds;
  /** `null` (or `Infinity`) while the agent is still running. */
  readonly end: ReplaySeconds | null;
}

/** The phase of `agent` at compressed time `t`. See the file header for the boundary rule. */
export function agentPhase(agent: AgentSpan, t: ReplaySeconds): AgentPhase {
  if (t < agent.start) return "waiting";
  if (agent.end !== null && t >= agent.end) return "finished";
  return "running";
}
