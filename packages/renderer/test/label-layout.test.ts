import type { ReplayModel } from "@orbitrace/core";
import { beforeAll, describe, expect, it } from "vitest";
import { scaledReplay } from "../demo/sessions.js";
import { drawFrame, type ViewState } from "../src/draw.js";
import {
  BOX_AGENT,
  BOX_DETAIL,
  BOX_WAVE,
  SPOT_OUTWARD,
  boardFits,
  boxesOverlap,
  createLabelBoard,
  placeLabels,
  wantsLabel,
  type LabelBoard,
} from "../src/label-layout.js";
import { computeLayout } from "../src/layout.js";
import { LABEL_BUDGET, LOD_FULL, LOD_MINIMAL } from "../src/lod.js";
import { createResources, ensureBoard, type DrawResources } from "../src/resources.js";
import { buildScene, type Scene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import {
  PHASE_ACTIVE,
  PHASE_DONE,
  computeFrameState,
  createFrameState,
  type FrameState,
} from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { MockContext, mockSurfaces } from "./support/mock-context.js";

/** Canvas sizes: the app's orrery at 1440x900, a laptop, a 1080p window, a narrow panel. */
const SIZES: readonly (readonly [number, number])[] = [
  [1080, 530],
  [1280, 800],
  [1920, 1080],
  [800, 600],
  [600, 420],
];

/** Mid-replay times of the demo golden: each wave running, the idle skip, and the end. */
const TIMES = [5, 40, 60, 75, 120, 180, 200, 230, 300, 345, 400, 490, 510, 535.07];

interface Drawn {
  scene: Scene;
  frame: FrameState;
  board: LabelBoard;
  res: DrawResources;
  ctx: MockContext;
}

/** Draw one frame through the real drawFrame and return the board it placed labels on. */
function draw(
  model: ReplayModel,
  width: number,
  height: number,
  t: number,
  selected = -1,
  hovered = -1,
  sceneOverride?: (scene: Scene) => Scene,
): Drawn {
  const built = buildScene(model);
  const scene = sceneOverride ? sceneOverride(built) : built;
  const layout = computeLayout(scene, width, height);
  const frame = computeFrameState(
    scene,
    t,
    { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false },
    createFrameState(scene),
  );
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const view: ViewState = { selected, hovered, ambient: 0, dpr: 1 };
  const ctx = new MockContext();
  drawFrame(ctx.asDrawContext(), scene, layout, frame, view, res);
  return { scene, frame, board: res.board, res, ctx };
}

/** Every pair of placed boxes that overlap, as readable strings (empty when none do). */
function overlaps(board: LabelBoard): string[] {
  const found: string[] = [];
  const b = board.boxes;
  for (let i = 0; i < board.boxCount; i++) {
    for (let j = i + 1; j < board.boxCount; j++) {
      const p = i * 4;
      const q = j * 4;
      if (
        boxesOverlap(
          b[p]!,
          b[p + 1]!,
          b[p + 2]!,
          b[p + 3]!,
          b[q]!,
          b[q + 1]!,
          b[q + 2]!,
          b[q + 3]!,
          0,
        )
      ) {
        found.push(
          `${board.boxKind[i]}:${board.boxOwner[i]} x ${board.boxKind[j]}:${board.boxOwner[j]}`,
        );
      }
    }
  }
  return found;
}

function shownAgents(drawn: Drawn): string[] {
  return drawn.scene.agents.filter((a) => drawn.board.agentShown[a.index] === 1).map((a) => a.id);
}

describe("boxesOverlap", () => {
  it("tells overlapping, touching and separate boxes apart, with a gap", () => {
    expect(boxesOverlap(0, 0, 10, 10, 5, 5, 15, 15, 0)).toBe(true);
    expect(boxesOverlap(0, 0, 10, 10, 10, 0, 20, 10, 0)).toBe(false);
    expect(boxesOverlap(0, 0, 10, 10, 11, 0, 20, 10, 2)).toBe(true);
    expect(boxesOverlap(0, 0, 10, 10, 13, 0, 20, 10, 2)).toBe(false);
    expect(boxesOverlap(0, 0, 10, 10, 0, 20, 10, 30, 0)).toBe(false);
  });
});

describe("label board", () => {
  it("is sized for a scene and grows only when a larger scene is drawn", () => {
    const board = createLabelBoard(10, 3);
    expect(boardFits(board, 10, 3)).toBe(true);
    expect(boardFits(board, 11, 3)).toBe(false);
    expect(boardFits(board, 10, 4)).toBe(false);
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    const first = ensureBoard(res, 20, 2);
    expect(ensureBoard(res, 15, 2)).toBe(first);
    const grown = ensureBoard(res, 40, 1);
    expect(grown).not.toBe(first);
    expect(grown.agentCapacity).toBe(40);
    expect(grown.waveCapacity).toBe(2);
  });
});

describe("label placement on the demo golden replay", () => {
  it.each(SIZES)("no two labels overlap at %ix%i, at every time, with any focus", (w, h) => {
    for (const t of TIMES) {
      for (const [selected, hovered] of [
        [-1, -1],
        [5, -1],
        [-1, 2],
        [0, 9],
        [11, 13],
      ] as const) {
        const drawn = draw(DEMO_GOLDEN, w, h, t, selected, hovered);
        expect([w, h, t, selected, hovered, overlaps(drawn.board)]).toEqual([
          w,
          h,
          t,
          selected,
          hovered,
          [],
        ]);
      }
    }
  });

  it.each(SIZES)("always shows the main, selected and hovered labels at %ix%i", (w, h) => {
    for (const t of TIMES) {
      const drawn = draw(DEMO_GOLDEN, w, h, t, 12, 3);
      expect(drawn.board.agentShown[0]).toBe(1);
      expect(drawn.board.agentShown[12]).toBe(1);
      expect(drawn.board.agentShown[3]).toBe(1);
      expect(drawn.ctx.texts()).toContain(DEMO_GOLDEN.agents[12]!.callsign);
    }
  });

  it("shows every running agent's label at the app's size, moving it off the wave labels", () => {
    // 1440x900 window: the orrery canvas is about 1080x530. At t = 200 wave 2 runs and the
    // first node of the orbit sits just right of the wave labels, so its label moves.
    const drawn = draw(DEMO_GOLDEN, 1080, 530, 200);
    const running = drawn.scene.agents.filter((a) => drawn.frame.phase[a.index] === PHASE_ACTIVE);
    expect(running.length).toBeGreaterThan(3);
    for (const a of running) expect([a.id, drawn.board.agentShown[a.index]]).toEqual([a.id, 1]);
    expect(drawn.board.dropped).toBe(0);
    const moved = running.filter(
      (a) => !a.isMain && drawn.board.agentSpot[a.index] !== SPOT_OUTWARD,
    );
    expect(moved.length).toBeGreaterThan(0);
    const kinds = new Set(Array.from(drawn.board.boxKind.subarray(0, drawn.board.boxCount)));
    expect(kinds.has(BOX_WAVE)).toBe(true);
    expect(kinds.has(BOX_AGENT)).toBe(true);
    expect(overlaps(drawn.board)).toEqual([]);
  });

  it("keeps the wave labels on a wide canvas and draws them where the board put them", () => {
    const drawn = draw(DEMO_GOLDEN, 1280, 800, 60);
    for (let w = 0; w < drawn.scene.waveCount; w++) expect(drawn.board.waveShown[w]).toBe(1);
    const wave = drawn.ctx.ops.find((o) => o.op === "fillText" && o.args[0] === "WAVE 1");
    expect(wave?.args[1]).toBe(drawn.board.waveLeft[0]);
    expect(wave?.args[2]).toBe(drawn.board.waveBase[0]);
  });

  it("draws no wave labels and no detail rows on a narrow canvas", () => {
    const drawn = draw(DEMO_GOLDEN, 600, 420, 200, 6);
    expect(Array.from(drawn.board.waveShown.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(drawn.board.detailWidth[6]).toBe(0);
    expect(drawn.board.agentShown[6]).toBe(1);
  });

  it("puts the selected agent's detail row next to its label without overlap", () => {
    const drawn = draw(DEMO_GOLDEN, 1080, 530, 300, 11);
    expect(drawn.board.detailWidth[11]).toBeGreaterThan(0);
    const kinds = Array.from(drawn.board.boxKind.subarray(0, drawn.board.boxCount));
    expect(kinds).toContain(BOX_DETAIL);
    expect(Math.abs(drawn.board.detailBase[11]! - drawn.board.agentBase[11]!)).toBe(14);
    expect(drawn.board.detailLeft[11]).toBeGreaterThan(0);
    expect(drawn.ctx.texts()).toContain("Sonnet · medium");
  });

  it("at the end, when every agent has finished, drops labels rather than overlap", () => {
    const drawn = draw(DEMO_GOLDEN, 600, 420, DEMO_GOLDEN.totals.duration, 9);
    expect(drawn.frame.activeSubagents).toBe(0);
    // Every finished agent wants its label back now.
    const wanting = drawn.scene.agents.filter((a) =>
      wantsLabel(drawn.scene, drawn.frame, drawn.board, a.index, 9, -1),
    );
    expect(wanting).toHaveLength(15);
    expect(shownAgents(drawn).length + drawn.board.dropped).toBe(15);
    expect(overlaps(drawn.board)).toEqual([]);
    // With labels too wide for the canvas, some must go; the selected one stays.
    const { scene, frame } = drawn;
    const layout = computeLayout(scene, 600, 420);
    const board = createLabelBoard(scene.agents.length, scene.waveCount);
    board.agentWidth.fill(400);
    board.agentSize.fill(10.5);
    placeLabels(scene, layout, frame, 9, -1, Infinity, true, board);
    expect(board.dropped).toBeGreaterThan(0);
    expect(
      Array.from(board.agentShown.subarray(0, 15)).filter(Boolean).length + board.dropped,
    ).toBe(15);
    expect(board.agentShown[9]).toBe(1);
    expect(board.agentShown[0]).toBe(1);
    expect(overlaps(board)).toEqual([]);
  });

  it("caps the labels of unfocused agents at the budget, never the focused ones", () => {
    const { scene, frame } = draw(DEMO_GOLDEN, 1280, 800, DEMO_GOLDEN.totals.duration);
    const layout = computeLayout(scene, 1280, 800);
    const board = createLabelBoard(scene.agents.length, scene.waveCount);
    for (let i = 0; i < scene.agents.length; i++) {
      board.agentWidth[i] = 60;
      board.agentSize[i] = 10.5;
    }
    placeLabels(scene, layout, frame, 4, 8, 2, true, board);
    const shown = Array.from(board.agentShown.subarray(0, scene.agents.length));
    expect(shown[0]).toBe(1);
    expect(shown[4]).toBe(1);
    expect(shown[8]).toBe(1);
    expect(shown.reduce((s, v) => s + v, 0)).toBe(3 + 2);
    placeLabels(scene, layout, frame, 4, -1, 0, true, board);
    expect(
      Array.from(board.agentShown.subarray(0, scene.agents.length)).filter(Boolean),
    ).toHaveLength(2);
  });

  it("places running labels before finished ones, in id order", () => {
    // Mid wave 2: the finished wave-1 agents want no label while others run.
    const drawn = draw(DEMO_GOLDEN, 1280, 800, 200);
    const finished = drawn.scene.agents.filter(
      (a) => !a.isMain && drawn.frame.phase[a.index] === PHASE_DONE,
    );
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.map((a) => drawn.board.agentShown[a.index])).toEqual(finished.map(() => 0));
    const order = Array.from(drawn.board.boxOwner.subarray(0, drawn.board.boxCount)).filter(
      (_, k) => drawn.board.boxKind[k] === BOX_AGENT,
    );
    expect(order[0]).toBe(0);
    expect(order.slice(1)).toEqual([...order.slice(1)].sort((a, b) => a - b));
  });

  it("places nothing on an empty canvas", () => {
    const drawn = draw(DEMO_GOLDEN, 0, 0, 100);
    expect(drawn.board.boxCount).toBe(0);
  });
});

describe("label placement above 100 agents", () => {
  const models = new Map<number, ReplayModel>();
  beforeAll(async () => {
    for (const agents of [100, 500]) models.set(agents, await scaledReplay(agents));
  });

  it.each([100, 500])("never overlaps and keeps to the budget at %i agents", (agents) => {
    const model = models.get(agents)!;
    const duration = model.totals.duration;
    for (const [w, h] of SIZES) {
      for (const f of [0.1, 0.35, 0.6, 0.85, 1]) {
        const drawn = draw(model, w, h, duration * f, 7, 30);
        expect([agents, w, h, f, overlaps(drawn.board)]).toEqual([agents, w, h, f, []]);
        const unfocused = shownAgents(drawn).filter(
          (id) => id !== "main" && id !== "a7" && id !== "a30",
        );
        expect(unfocused.length).toBeLessThanOrEqual(LABEL_BUDGET[drawn.scene.lod]!);
        expect(drawn.board.agentShown[7]).toBe(1);
        expect(drawn.board.agentShown[30]).toBe(1);
      }
    }
  });

  it("shows more labels at full detail than the minimal level allows", () => {
    const model = models.get(500)!;
    const t = model.totals.duration * 0.35;
    const minimal = draw(model, 1920, 1080, t);
    const full = draw(model, 1920, 1080, t, -1, -1, (s) => ({ ...s, lod: LOD_FULL }));
    expect(minimal.scene.lod).toBe(LOD_MINIMAL);
    expect(shownAgents(minimal).length - 1).toBeLessThanOrEqual(LABEL_BUDGET[LOD_MINIMAL]!);
    expect(shownAgents(full).length).toBeGreaterThan(shownAgents(minimal).length);
    expect(overlaps(full.board)).toEqual([]);
  });
});
