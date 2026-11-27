import { describeReplayProblems, type ReplayModel } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import minimal from "../../../fixtures/replays/minimal.replay.json" with { type: "json" };
import {
  DEFAULT_AGENTS_PER_WAVE,
  demoReplay,
  scaledReplay,
  scaledSession,
  sessionBytes,
  sessionInput,
} from "../demo/sessions.js";
import { drawFrame } from "../src/draw.js";
import { computeLayout } from "../src/layout.js";
import { createResources } from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import { computeFrameState, createFrameState } from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { MockContext, mockSurfaces } from "./support/mock-context.js";
import { smallModel } from "./support/models.js";

/** Draw `steps` frames across the whole model; return totals at the end. */
function playThrough(model: ReplayModel, steps = 50) {
  const scene = buildScene(model);
  const layout = computeLayout(scene, 1200, 800);
  const frame = createFrameState(scene);
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const ctx = new MockContext(false);
  for (let k = 0; k <= steps; k++) {
    computeFrameState(
      scene,
      (scene.duration * k) / steps,
      { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false },
      frame,
    );
    drawFrame(
      ctx.asDrawContext(),
      scene,
      layout,
      frame,
      { selected: 1, hovered: -1, ambient: k / 60, dpr: 1 },
      res,
    );
  }
  return frame;
}

describe("replays the renderer is tested and benchmarked on", () => {
  it("the hand-built test model is a valid v1 replay", () => {
    expect(describeReplayProblems(smallModel())).toEqual([]);
  });

  it("the demo replay comes from core's pipeline and equals the committed demo golden", async () => {
    const model = await demoReplay();
    expect(describeReplayProblems(model)).toEqual([]);
    expect(model).toEqual(DEMO_GOLDEN);
  });

  it("scaled sessions have the asked-for number of agents, in waves, and are deterministic", async () => {
    const model = await scaledReplay(60);
    expect(describeReplayProblems(model)).toEqual([]);
    expect(model.agents).toHaveLength(60);
    const waves = new Set(
      model.agents.flatMap((agent) => (agent.wave === null ? [] : [agent.wave])),
    );
    expect(waves.size).toBe(Math.ceil(59 / DEFAULT_AGENTS_PER_WAVE));
    expect(await scaledReplay(60)).toEqual(model);
    expect(await scaledReplay(60, { seed: "other" })).not.toEqual(model);
    expect(await scaledReplay(1)).toMatchObject({ agents: [{ id: "main" }] });
    expect(() => scaledSession(0)).toThrow(RangeError);
  });

  it("splits a generated session into the parser's input and counts its bytes", () => {
    const session = scaledSession(3, { agentsPerWave: 2 });
    const input = sessionInput(session);
    expect(input.subagents).toHaveLength(2);
    expect([...(input.main as Iterable<string>)].every((line) => line.startsWith("{"))).toBe(true);
    const bytes = session.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    expect(sessionBytes(session)).toBe(bytes);
  });

  it("plays the repository's minimal fixture to the end with totals matching the file", () => {
    const model = minimal as unknown as ReplayModel;
    expect(describeReplayProblems(model)).toEqual([]);
    const frame = playThrough(model);
    expect(frame.toolsStarted).toBe(model.totals.toolCalls);
    expect(frame.toolsFailed).toBe(model.totals.failedToolCalls);
    expect(frame.outputTokens).toBe(model.totals.outputTokens);
  });

  it("plays the demo replay to the end with totals matching the model", async () => {
    const model = await demoReplay();
    const frame = playThrough(model, 200);
    expect(frame.toolsStarted).toBe(model.totals.toolCalls);
    expect(frame.toolsFailed).toBe(model.totals.failedToolCalls);
    expect(frame.outputTokens).toBe(model.totals.outputTokens);
  });
});
