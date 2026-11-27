/**
 * Timeline state at time `t`: which agents exist, which calls are in flight, how far each
 * agent's token arc is filled, and the progress of every short effect. Pure: it reads a
 * scene and writes into a preallocated FrameState, so computing a frame allocates nothing.
 *
 * Effects such as comets and pulses last a fixed number of real seconds. They are expressed
 * in replay seconds as `realSeconds * speed`, which keeps every frame a pure function of
 * (`t`, `speed`): when the host pauses, `t` stops and so does every effect.
 */

import { agentPhase, type AgentSpan } from "@orbitrace/core";
import type { Scene } from "./scene.js";

/** Lengths of short effects, in real seconds at the current playback speed. */
export const EFFECT_SECONDS = Object.freeze({
  comet: 0.9,
  pulse: 0.55,
  spawn: 0.7,
  flareGrow: 0.12,
  flareTail: 0.35,
  moonFresh: 0.5,
  warp: 1.6,
});

/** Default minimum time, in real seconds, that a call stays visible as a spoke. */
export const DEFAULT_MIN_VISIBLE_CALL_SECONDS = 0.3;

export const PHASE_QUEUED = 0;
export const PHASE_ACTIVE = 1;
export const PHASE_DONE = 2;

export interface TimingParams {
  /** Playback rate of the host's clock. Greater than 0. */
  readonly speed: number;
  readonly minVisibleCallSeconds: number;
  /** Still frames: no growth, fade, comet, pulse, flash or warp. */
  readonly reducedMotion: boolean;
}

export interface FrameState {
  t: number;
  speed: number;
  reducedMotion: boolean;
  /** Minimum visible call time in replay seconds. */
  minVisible: number;
  /** PHASE_* per agent. */
  readonly phase: Uint8Array;
  /** Calls started by `t`, per agent. */
  readonly started: Uint32Array;
  /** Calls with a result by `t`, per agent. */
  readonly finished: Uint32Array;
  /** Finished calls that failed, per agent. */
  readonly failed: Uint32Array;
  /** Replies seen by `t`, per agent. */
  readonly replies: Uint32Array;
  /** Output tokens of the replies seen by `t`, per agent. */
  readonly output: Float64Array;
  /** Token arc fill from 0 to 1: `output / scene.maxOutput`. */
  readonly arc: Float64Array;
  /** Dispatch comet progress from 0 to 1, or -1 when not shown. */
  readonly dispatch: Float32Array;
  /** Handback comet progress from 0 to 1, or -1 when not shown. */
  readonly handback: Float32Array;
  /** Spawn flash progress from 0 to 1, or -1 when not shown. */
  readonly spawn: Float32Array;
  /** Number of valid entries in the flight arrays. */
  flightCount: number;
  /** Flights of agent `i` are entries `flightOffset[i]` to `flightOffset[i + 1] - 1`. */
  readonly flightOffset: Uint32Array;
  readonly flightAgent: Uint32Array;
  readonly flightTool: Uint32Array;
  /** Spoke length factor from 0 to 1. */
  readonly flightGrow: Float32Array;
  /** Spoke opacity from 0 to 1 (fades after the call's visible end). */
  readonly flightAlpha: Float32Array;
  /** 1 while the call is inside its visible window, 0 while it fades. */
  readonly flightRunning: Uint8Array;
  activeAgents: number;
  activeSubagents: number;
  toolsStarted: number;
  toolsFailed: number;
  outputTokens: number;
  /** Index of the warp whose effect is showing, or -1. */
  warpIndex: number;
  /** Warp effect strength from 0 to 1. */
  warpFactor: number;
}

export function createFrameState(scene: Pick<Scene, "agents" | "totalTools">): FrameState {
  const n = scene.agents.length;
  const calls = Math.max(1, scene.totalTools);
  return {
    t: 0,
    speed: 1,
    reducedMotion: false,
    minVisible: 0,
    phase: new Uint8Array(n),
    started: new Uint32Array(n),
    finished: new Uint32Array(n),
    failed: new Uint32Array(n),
    replies: new Uint32Array(n),
    output: new Float64Array(n),
    arc: new Float64Array(n),
    dispatch: new Float32Array(n),
    handback: new Float32Array(n),
    spawn: new Float32Array(n),
    flightCount: 0,
    flightOffset: new Uint32Array(n + 1),
    flightAgent: new Uint32Array(calls),
    flightTool: new Uint32Array(calls),
    flightGrow: new Float32Array(calls),
    flightAlpha: new Float32Array(calls),
    flightRunning: new Uint8Array(calls),
    activeAgents: 0,
    activeSubagents: 0,
    toolsStarted: 0,
    toolsFailed: 0,
    outputTokens: 0,
    warpIndex: -1,
    warpFactor: 0,
  };
}

/** True when `frame` was created for a scene of this size. */
export function frameFits(frame: FrameState, scene: Scene): boolean {
  return (
    frame.phase.length === scene.agents.length &&
    frame.flightAgent.length === Math.max(1, scene.totalTools)
  );
}

/** Number of entries in the sorted `values[0..count)` that are less than or equal to `x`. */
export function upperBound(values: Float64Array, count: number, x: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * PHASE_* of an agent at `t`, by core's one phase rule (`agentPhase`, #108): active in
 * `[start, end)`, done from `end` on, so the canvas and the app's inspector agree at the end
 * instant. `end` is `Infinity` while the agent runs, which core treats like `null`.
 */
export function phaseCode(agent: AgentSpan, t: number): number {
  switch (agentPhase(agent, t)) {
    case "waiting":
      return PHASE_QUEUED;
    case "running":
      return PHASE_ACTIVE;
    default:
      return PHASE_DONE;
  }
}

/** End of a call's visible window: its end, but at least `minVisible` after its start. */
export function visibleEnd(start: number, end: number, minVisible: number): number {
  return Math.max(end, start + minVisible);
}

/** Progress of an effect that starts at `from` and lasts `length`; -1 outside it. */
export function effectProgress(t: number, from: number, length: number): number {
  if (!(length > 0)) return -1;
  const p = (t - from) / length;
  return p >= 0 && p <= 1 ? p : -1;
}

/** Fill `out` with the state at time `t`. Allocates nothing. */
export function computeFrameState(
  scene: Scene,
  t: number,
  params: TimingParams,
  out: FrameState,
): FrameState {
  const speed = params.speed > 0 ? params.speed : 1;
  const reduced = params.reducedMotion;
  const minVisible = Math.max(0, params.minVisibleCallSeconds) * speed;
  const tail = reduced ? 0 : EFFECT_SECONDS.flareTail * speed;
  const growTime = reduced ? 0 : EFFECT_SECONDS.flareGrow * speed;
  const comet = EFFECT_SECONDS.comet * speed;
  const spawn = EFFECT_SECONDS.spawn * speed;
  const maxOutput = scene.maxOutput;

  out.t = t;
  out.speed = speed;
  out.reducedMotion = reduced;
  out.minVisible = minVisible;
  out.flightCount = 0;
  out.activeAgents = 0;
  out.activeSubagents = 0;
  out.toolsStarted = 0;
  out.toolsFailed = 0;
  out.outputTokens = 0;

  const agents = scene.agents;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i]!;
    out.flightOffset[i] = out.flightCount;
    const phase = phaseCode(a, t);
    out.phase[i] = phase;
    if (phase === PHASE_ACTIVE) {
      out.activeAgents++;
      if (!a.isMain) out.activeSubagents++;
    }

    const replies = upperBound(a.replyT, a.replyCount, t);
    out.replies[i] = replies;
    const output = a.outputPrefix[replies]!;
    out.output[i] = output;
    out.arc[i] = maxOutput > 0 ? output / maxOutput : 0;
    out.outputTokens += output;

    const started = upperBound(a.toolStart, a.toolCount, t);
    out.started[i] = started;
    out.toolsStarted += started;
    let finished = 0;
    let failed = 0;
    for (let j = 0; j < started; j++) {
      const end = a.toolEnd[j]!;
      if (end <= t && a.toolOpen[j] === 0) {
        finished++;
        if (a.toolFailed[j] === 1) failed++;
      }
      if (a.toolSkip[j] === 1) continue;
      const start = a.toolStart[j]!;
      const shownUntil = visibleEnd(start, end, minVisible);
      if (t > shownUntil + tail) continue;
      const k = out.flightCount++;
      out.flightAgent[k] = i;
      out.flightTool[k] = j;
      out.flightGrow[k] = growTime > 0 ? Math.min(1, (t - start) / growTime) : 1;
      const running = t <= shownUntil;
      out.flightRunning[k] = running ? 1 : 0;
      out.flightAlpha[k] = running ? 1 : tail > 0 ? Math.max(0, 1 - (t - shownUntil) / tail) : 0;
    }
    out.finished[i] = finished;
    out.failed[i] = failed;
    out.toolsFailed += failed;

    if (reduced || a.isMain) {
      out.dispatch[i] = -1;
      out.handback[i] = -1;
      out.spawn[i] = -1;
    } else {
      out.dispatch[i] = effectProgress(t, a.start - comet, comet);
      out.handback[i] = a.end === Infinity ? -1 : effectProgress(t, a.end, comet);
      out.spawn[i] = effectProgress(t, a.start, spawn);
    }
  }

  out.flightOffset[agents.length] = out.flightCount;

  out.warpIndex = -1;
  out.warpFactor = 0;
  if (!reduced) {
    const length = EFFECT_SECONDS.warp * speed;
    for (let w = 0; w < scene.warpAt.length; w++) {
      const p = effectProgress(t, scene.warpAt[w]!, length);
      if (p >= 0) {
        out.warpIndex = w;
        out.warpFactor = Math.sin(Math.PI * p);
      }
    }
  }
  return out;
}
