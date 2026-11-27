import { agentPhase } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { HIT_PADDING, hitTestAgents } from "../src/hit.js";
import { computeLayout } from "../src/layout.js";
import { buildScene } from "../src/scene.js";
import {
  EFFECT_SECONDS,
  PHASE_ACTIVE,
  PHASE_DONE,
  PHASE_QUEUED,
  phaseCode,
  computeFrameState,
  createFrameState,
  effectProgress,
  frameFits,
  upperBound,
  visibleEnd,
  type TimingParams,
} from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { emptyModel, smallModel } from "./support/models.js";

const timing = (over: Partial<TimingParams> = {}): TimingParams => ({
  speed: 1,
  minVisibleCallSeconds: 0.3,
  reducedMotion: false,
  ...over,
});

describe("timeline helpers", () => {
  it("counts sorted values up to x", () => {
    const values = new Float64Array([1, 2, 2, 5, 9]);
    expect(upperBound(values, 5, 0)).toBe(0);
    expect(upperBound(values, 5, 2)).toBe(3);
    expect(upperBound(values, 5, 100)).toBe(5);
    expect(upperBound(values, 3, 100)).toBe(3);
  });

  it("gives an agent's phase by core's half-open rule, at the boundary instants (#108)", () => {
    const span = { start: 10, end: 20 };
    expect(phaseCode(span, 5)).toBe(PHASE_QUEUED);
    expect(phaseCode(span, 9.999)).toBe(PHASE_QUEUED);
    expect(phaseCode(span, 10)).toBe(PHASE_ACTIVE);
    expect(phaseCode(span, 19.999)).toBe(PHASE_ACTIVE);
    expect(phaseCode(span, 20)).toBe(PHASE_DONE);
    expect(phaseCode(span, 21)).toBe(PHASE_DONE);
    expect(phaseCode({ start: 10, end: Infinity }, 1e9)).toBe(PHASE_ACTIVE);
    expect(phaseCode({ start: 10, end: null }, 1e9)).toBe(PHASE_ACTIVE);
  });

  it("draws every agent of the demo golden in the phase the app's inspector shows", () => {
    const scene = buildScene(DEMO_GOLDEN);
    const frame = createFrameState(scene);
    const code = { waiting: PHASE_QUEUED, running: PHASE_ACTIVE, finished: PHASE_DONE };
    for (const agent of DEMO_GOLDEN.agents) {
      for (const t of [agent.start - 0.001, agent.start, agent.end! - 0.001, agent.end!]) {
        if (t < 0) continue;
        computeFrameState(scene, t, timing(), frame);
        const i = scene.byId.get(agent.id)!;
        expect([agent.id, t, frame.phase[i]]).toEqual([agent.id, t, code[agentPhase(agent, t)]]);
      }
    }
    // The last frame of playback shows the main agent finished, as the inspector says.
    computeFrameState(scene, scene.duration, timing(), frame);
    expect(frame.phase[0]).toBe(PHASE_DONE);
  });

  it("gives short calls a minimum visible window", () => {
    expect(visibleEnd(10, 10.1, 2)).toBe(12);
    expect(visibleEnd(10, 30, 2)).toBe(30);
  });

  it("computes effect progress inside the window only", () => {
    expect(effectProgress(5, 4, 2)).toBe(0.5);
    expect(effectProgress(3, 4, 2)).toBe(-1);
    expect(effectProgress(7, 4, 2)).toBe(-1);
    expect(effectProgress(4, 4, 0)).toBe(-1);
  });
});

describe("computeFrameState", () => {
  const scene = buildScene(smallModel());
  const frame = createFrameState(scene);

  it("fits the scene it was made for", () => {
    expect(frameFits(frame, scene)).toBe(true);
    expect(frameFits(frame, buildScene(emptyModel()))).toBe(false);
  });

  it("knows which agents exist at t", () => {
    computeFrameState(scene, 5, timing(), frame);
    expect([...frame.phase]).toEqual([
      PHASE_ACTIVE,
      PHASE_QUEUED,
      PHASE_QUEUED,
      PHASE_QUEUED,
      PHASE_QUEUED,
    ]);
    computeFrameState(scene, 62, timing(), frame);
    expect([...frame.phase]).toEqual([
      PHASE_ACTIVE,
      PHASE_DONE,
      PHASE_ACTIVE,
      PHASE_QUEUED,
      PHASE_QUEUED,
    ]);
    expect(frame.activeSubagents).toBe(1);
    // t = 100 is the main agent's end: finished at that instant (#108), as the inspector says.
    computeFrameState(scene, 100, timing(), frame);
    expect([...frame.phase]).toEqual([
      PHASE_DONE,
      PHASE_DONE,
      PHASE_DONE,
      PHASE_ACTIVE,
      PHASE_DONE,
    ]);
    computeFrameState(scene, 99.999, timing(), frame);
    expect(frame.phase[0]).toBe(PHASE_ACTIVE);
  });

  it("counts started, finished and failed calls", () => {
    computeFrameState(scene, 16, timing(), frame);
    expect(frame.started[1]).toBe(2);
    expect(frame.finished[1]).toBe(2);
    expect(frame.failed[1]).toBe(1);
    computeFrameState(scene, 100, timing(), frame);
    // The open Bash call never got a result, so it never counts as finished.
    expect(frame.started[1]).toBe(3);
    expect(frame.finished[1]).toBe(2);
    expect(frame.toolsStarted).toBe(11);
  });

  it("lists calls in flight, with the open call in flight until its agent ends", () => {
    computeFrameState(scene, 30, timing(), frame);
    const flights = [];
    for (let k = frame.flightOffset[1]!; k < frame.flightOffset[2]!; k++)
      flights.push(frame.flightTool[k]);
    expect(flights).toEqual([2]);
    computeFrameState(scene, 61, timing({ reducedMotion: true }), frame);
    expect(frame.flightOffset[2]! - frame.flightOffset[1]!).toBe(0);
  });

  it("never lists the main agent's agent calls as spokes", () => {
    computeFrameState(scene, 30, timing(), frame);
    for (let k = frame.flightOffset[0]!; k < frame.flightOffset[1]!; k++) {
      expect(scene.agents[0]!.toolSkip[frame.flightTool[k]!]).toBe(0);
    }
  });

  it("keeps a short call visible for the minimum time, scaled by speed", () => {
    // a2's Edit lasts 0.1 s at t=40. At speed 10 the 0.3 s minimum is 3 replay seconds.
    computeFrameState(scene, 42, timing({ speed: 10 }), frame);
    expect(frame.flightOffset[3]! - frame.flightOffset[2]!).toBe(1);
    const k = frame.flightOffset[2]!;
    expect(frame.flightRunning[k]).toBe(1);
    expect(frame.flightAlpha[k]).toBe(1);
    computeFrameState(scene, 42, timing({ speed: 1 }), frame);
    expect(frame.flightOffset[3]! - frame.flightOffset[2]!).toBe(0);
  });

  it("fades a call after its window and grows it at the start", () => {
    // speed 10: window ends at 43, fade lasts 3.5 replay seconds.
    computeFrameState(scene, 44.75, timing({ speed: 10 }), frame);
    const k = frame.flightOffset[2]!;
    expect(frame.flightRunning[k]).toBe(0);
    expect(frame.flightAlpha[k]).toBeCloseTo(0.5);
    computeFrameState(scene, 40.6, timing({ speed: 10 }), frame);
    expect(frame.flightGrow[frame.flightOffset[2]!]).toBeCloseTo(0.5);
  });

  it("fills the token arc relative to the busiest agent", () => {
    computeFrameState(scene, 20, timing(), frame);
    expect(frame.output[1]).toBe(300);
    expect(frame.arc[1]).toBeCloseTo(0.3);
    expect(frame.arc[2]).toBe(1);
    expect(frame.replies[0]).toBe(2);
  });

  it("times dispatch and handback comets in real seconds", () => {
    const speed = 10;
    const length = EFFECT_SECONDS.comet * speed;
    computeFrameState(scene, 10 - length / 2, timing({ speed }), frame);
    expect(frame.dispatch[1]).toBeCloseTo(0.5);
    computeFrameState(scene, 60 + length / 4, timing({ speed }), frame);
    expect(frame.handback[1]).toBeCloseTo(0.25);
    expect(frame.handback[3]).toBe(-1);
    expect(frame.dispatch[0]).toBe(-1);
  });

  it("shows the warp effect just after a warp", () => {
    computeFrameState(scene, 66 + EFFECT_SECONDS.warp / 2, timing(), frame);
    expect(frame.warpIndex).toBe(0);
    expect(frame.warpFactor).toBeCloseTo(1);
    computeFrameState(scene, 80, timing(), frame);
    expect(frame.warpIndex).toBe(-1);
  });

  it("has no comets, flashes, fades or warps with reduced motion", () => {
    const reduced = timing({ reducedMotion: true, speed: 10 });
    computeFrameState(scene, 10, reduced, frame);
    expect([...frame.dispatch].every((v) => v === -1)).toBe(true);
    expect([...frame.spawn].every((v) => v === -1)).toBe(true);
    computeFrameState(scene, 66.5, reduced, frame);
    expect(frame.warpIndex).toBe(-1);
    computeFrameState(scene, 40.01, reduced, frame);
    expect(frame.flightGrow[frame.flightOffset[2]!]).toBe(1);
  });
});

describe("hitTestAgents", () => {
  const scene = buildScene(smallModel());
  const layout = computeLayout(scene, 1000, 800);
  const frame = createFrameState(scene);

  it("finds the agent under the point", () => {
    computeFrameState(scene, 30, timing(), frame);
    expect(hitTestAgents(layout, frame.phase, layout.x[1]!, layout.y[1]!)).toBe(1);
    expect(
      hitTestAgents(
        layout,
        frame.phase,
        layout.x[1]! + layout.ro[1]! + HIT_PADDING - 1,
        layout.y[1]!,
      ),
    ).toBe(1);
    expect(hitTestAgents(layout, frame.phase, 500, 400)).toBe(0);
    expect(hitTestAgents(layout, frame.phase, 2, 2)).toBe(-1);
  });

  it("cannot hit an agent that has not started", () => {
    computeFrameState(scene, 30, timing(), frame);
    expect(hitTestAgents(layout, frame.phase, layout.x[3]!, layout.y[3]!)).toBe(-1);
    computeFrameState(scene, 80, timing(), frame);
    expect(hitTestAgents(layout, frame.phase, layout.x[3]!, layout.y[3]!)).toBe(3);
  });
});
