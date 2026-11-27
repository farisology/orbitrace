import type { ReplayModel } from "@orbitrace/core";
import { beforeAll, describe, expect, it } from "vitest";
import { scaledReplay } from "../demo/sessions.js";
import { drawFrame } from "../src/draw.js";
import { createLabelBoard } from "../src/label-layout.js";
import { computeLayout } from "../src/layout.js";
import {
  LABEL_BUDGET,
  LOD_FULL,
  LOD_FULL_MAX_AGENTS,
  LOD_MINIMAL,
  LOD_REDUCED,
  LOD_REDUCED_MAX_AGENTS,
  drawsMoonGlow,
  drawsMoons,
  drawsSpokeTags,
  labelsAvoidNodes,
  lodFor,
  markCollapsedWaves,
} from "../src/lod.js";
import { createResources } from "../src/resources.js";
import { buildScene, type Scene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import {
  PHASE_ACTIVE,
  PHASE_DONE,
  PHASE_QUEUED,
  computeFrameState,
  createFrameState,
} from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { MockContext, mockSurfaces } from "./support/mock-context.js";

const timing = { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false };

/** Canvas calls of one frame of `scene` at time `t`, by op name. */
function opsAt(scene: Scene, t: number, selected = -1) {
  const layout = computeLayout(scene, 1280, 800);
  const frame = computeFrameState(scene, t, timing, createFrameState(scene));
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const ctx = new MockContext();
  drawFrame(
    ctx.asDrawContext(),
    scene,
    layout,
    frame,
    { selected, hovered: -1, ambient: 0, dpr: 1 },
    res,
  );
  return { ctx, board: res.board, frame };
}

describe("level of detail thresholds", () => {
  it("is chosen from the agent count, in fixed steps", () => {
    expect(LOD_FULL_MAX_AGENTS).toBe(100);
    expect(LOD_REDUCED_MAX_AGENTS).toBe(250);
    expect(lodFor(1)).toBe(LOD_FULL);
    expect(lodFor(15)).toBe(LOD_FULL);
    expect(lodFor(100)).toBe(LOD_FULL);
    expect(lodFor(101)).toBe(LOD_REDUCED);
    expect(lodFor(250)).toBe(LOD_REDUCED);
    expect(lodFor(251)).toBe(LOD_MINIMAL);
    expect(lodFor(5000)).toBe(LOD_MINIMAL);
    expect(buildScene(DEMO_GOLDEN).lod).toBe(LOD_FULL);
  });

  it("caps labels only above full detail", () => {
    expect(LABEL_BUDGET[LOD_FULL]).toBe(Infinity);
    expect(LABEL_BUDGET[LOD_REDUCED]).toBe(24);
    expect(LABEL_BUDGET[LOD_MINIMAL]).toBe(12);
    expect(labelsAvoidNodes(LOD_FULL)).toBe(true);
    expect(labelsAvoidNodes(LOD_REDUCED)).toBe(false);
  });

  it("drops finished agents' moons when reduced and all moons when minimal, except focused", () => {
    for (const phase of [PHASE_ACTIVE, PHASE_DONE]) {
      expect(drawsMoons(LOD_FULL, phase, false)).toBe(true);
      expect(drawsMoons(LOD_MINIMAL, phase, false)).toBe(false);
      expect(drawsMoons(LOD_MINIMAL, phase, true)).toBe(true);
    }
    expect(drawsMoons(LOD_REDUCED, PHASE_ACTIVE, false)).toBe(true);
    expect(drawsMoons(LOD_REDUCED, PHASE_DONE, false)).toBe(false);
    expect(drawsMoons(LOD_REDUCED, PHASE_DONE, true)).toBe(true);
    expect(drawsMoonGlow(LOD_FULL)).toBe(true);
    expect(drawsMoonGlow(LOD_REDUCED)).toBe(false);
    expect(drawsSpokeTags(LOD_REDUCED)).toBe(true);
    expect(drawsSpokeTags(LOD_MINIMAL)).toBe(false);
  });
});

describe("ring summaries", () => {
  const models = new Map<number, ReplayModel>();
  beforeAll(async () => {
    for (const agents of [100, 200, 500]) models.set(agents, await scaledReplay(agents));
  });

  it("collapse exactly the waves whose agents have all finished, at minimal detail only", () => {
    const scene = buildScene(models.get(500)!);
    expect(scene.lod).toBe(LOD_MINIMAL);
    const frame = createFrameState(scene);
    const board = createLabelBoard(scene.agents.length, scene.waveCount);
    let sawCollapsed = false;
    for (const f of [0, 0.2, 0.5, 0.8, 1]) {
      computeFrameState(scene, scene.duration * f, timing, frame);
      const count = markCollapsedWaves(
        scene,
        frame,
        scene.lod,
        board.waveCollapsed,
        board.waveOpen,
      );
      for (let w = 0; w < scene.waveCount; w++) {
        const members = scene.agents.filter((a) => a.wave === w);
        const allDone = members.every((a) => frame.phase[a.index] === PHASE_DONE);
        // A wave with an agent still queued is not finished, so it never collapses.
        const queued = members.some((a) => frame.phase[a.index] === PHASE_QUEUED);
        expect(queued && allDone).toBe(false);
        expect([f, w, board.waveCollapsed[w]]).toEqual([f, w, allDone ? 1 : 0]);
      }
      expect(count).toBe(
        Array.from(board.waveCollapsed.subarray(0, scene.waveCount)).filter(Boolean).length,
      );
      sawCollapsed ||= count > 0;
    }
    expect(sawCollapsed).toBe(true);
    // Below minimal detail nothing collapses.
    const reduced = buildScene(models.get(200)!);
    const reducedFrame = computeFrameState(
      reduced,
      reduced.duration,
      timing,
      createFrameState(reduced),
    );
    expect(
      markCollapsedWaves(reduced, reducedFrame, reduced.lod, board.waveCollapsed, board.waveOpen),
    ).toBe(0);
  });

  it("draw a finished wave as dots with a summary label, and the focused agent in full", () => {
    const scene = buildScene(models.get(500)!);
    const t = scene.duration * 0.8;
    const firstWave = scene.agents.filter((a) => a.wave === 0);
    const focused = firstWave[3]!.index;
    const { ctx, board } = opsAt(scene, t, focused);
    expect(board.waveCollapsed[0]).toBe(1);
    expect(board.agentShown[focused]).toBe(1);
    expect(ctx.texts()).toContain(scene.agents[focused]!.agent.callsign);
    expect(ctx.texts().some((text) => /^WAVE \d+ · 25 done$/.test(text))).toBe(true);
    // No other agent of a collapsed wave has a label.
    const others = firstWave.filter((a) => a.index !== focused);
    expect(others.map((a) => board.agentShown[a.index])).toEqual(others.map(() => 0));
  });

  it("cut the canvas work of a 500-agent frame to a fraction of full detail", () => {
    const scene = buildScene(models.get(500)!);
    for (const f of [0.5, 1]) {
      const t = scene.duration * f;
      const minimal = opsAt(scene, t).ctx;
      const full = opsAt({ ...scene, lod: LOD_FULL }, t).ctx;
      expect(minimal.count("arc")).toBeLessThan(full.count("arc") / 3);
      expect(minimal.count("fillText")).toBeLessThanOrEqual(full.count("fillText"));
    }
  });

  it("keep everything at 100 agents: the budget size draws at full detail", () => {
    const scene = buildScene(models.get(100)!);
    expect(scene.lod).toBe(LOD_FULL);
    const t = scene.duration;
    const { board } = opsAt(scene, t);
    expect(Array.from(board.waveCollapsed.subarray(0, scene.waveCount)).every((v) => v === 0)).toBe(
      true,
    );
  });
});
