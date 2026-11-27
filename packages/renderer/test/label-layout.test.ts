import type { ReplayModel } from "@orbitrace/core";
import { beforeAll, describe, expect, it } from "vitest";
import { scaledReplay } from "../demo/sessions.js";
import { drawFrame, type ViewState } from "../src/draw.js";
import {
  BOX_AGENT,
  BOX_DETAIL,
  BOX_WAVE,
  WAVE_BINS,
  WAVE_FADE_SECONDS,
  WAVE_HALF_HEIGHT,
  WAVE_PAD_X,
  boardFits,
  boxesOverlap,
  createLabelBoard,
  placeLabels,
  angleOf,
  waveBinAngle,
  waveBinBlocked,
  wantsLabel,
  type LabelBoard,
} from "../src/label-layout.js";
import { computeLayout, type Layout } from "../src/layout.js";
import { LABEL_BUDGET, LOD_FULL, LOD_MINIMAL } from "../src/lod.js";
import { createResources, ensureBoard, type DrawResources } from "../src/resources.js";
import { buildScene, type Scene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import {
  PHASE_ACTIVE,
  PHASE_DONE,
  PHASE_QUEUED,
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

  it("shows every running agent's label and every wave label at the app's size", () => {
    // 1440x900 window: the orrery canvas is about 1080x530. At t = 200 wave 2 runs.
    const drawn = draw(DEMO_GOLDEN, 1080, 530, 200);
    const running = drawn.scene.agents.filter((a) => drawn.frame.phase[a.index] === PHASE_ACTIVE);
    expect(running.length).toBeGreaterThan(3);
    for (const a of running) expect([a.id, drawn.board.agentShown[a.index]]).toEqual([a.id, 1]);
    expect(drawn.board.dropped).toBe(0);
    for (let w = 0; w < drawn.scene.waveCount; w++) expect(drawn.board.waveShown[w]).toBe(1);
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

  it("keeps the wave labels but draws no detail rows on a narrow canvas", () => {
    const drawn = draw(DEMO_GOLDEN, 600, 420, 200, 6);
    expect(Array.from(drawn.board.waveShown.subarray(0, 4))).toEqual([1, 1, 1, 1]);
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

/** The box placed for wave `w`'s label, as [left, top, right, bottom], and its index. */
function waveBox(board: LabelBoard, w: number): { box: number[]; index: number } | null {
  for (let k = 0; k < board.boxCount; k++) {
    if (board.boxKind[k] === BOX_WAVE && board.boxOwner[k] === w) {
      return { box: Array.from(board.boxes.subarray(k * 4, k * 4 + 4)), index: k };
    }
  }
  return null;
}

/**
 * What wave `w`'s label box covers, computed apart from label-layout.ts from the drawing
 * geometry in draw.ts: node bodies with their token arc, and spokes with their tip dot.
 */
function coveredBy(drawn: Drawn, layout: Layout, w: number): string[] {
  const found = waveBox(drawn.board, w);
  if (found === null) return [];
  const [l, t, r, b] = found.box as [number, number, number, number];
  const hits: string[] = [];
  const { scene, frame } = drawn;
  for (const a of scene.agents) {
    const i = a.index;
    if (!a.isMain && frame.phase[i] === PHASE_QUEUED) continue;
    const x = layout.x[i]!;
    const y = layout.y[i]!;
    const ro = layout.ro[i]!;
    // Token arc: radius ro + 3, 2.4 wide.
    const reach = ro + 4.2;
    if (boxesOverlap(l, t, r, b, x - reach, y - reach, x + reach, y + reach, 0)) {
      hits.push(`node ${a.id}`);
    }
    for (let k = frame.flightOffset[i]!; k < frame.flightOffset[i + 1]!; k++) {
      if (!(frame.flightAlpha[k]! > 0.05)) continue;
      const j = frame.flightTool[k]!;
      const angle = a.isMain ? a.flareAngle[j]! : layout.angle[i]! + a.flareAngle[j]!;
      const r0 = ro + 7;
      const end = r0 + a.flareLength[j]! * frame.flightGrow[k]!;
      for (let s = 0; s <= 8; s++) {
        const d = r0 + ((end - r0) * s) / 8;
        const px = x + Math.cos(angle) * d;
        const py = y + Math.sin(angle) * d;
        const pad = s === 8 ? 3 : 0.7;
        if (boxesOverlap(l, t, r, b, px - pad, py - pad, px + pad, py + pad, 0)) {
          hits.push(`beam ${a.id}`);
          break;
        }
      }
    }
  }
  return hits;
}

/** The app's orrery canvas in a 1440x900 and a 1280x800 window, measured in the screenshots. */
const APP_SIZES: readonly (readonly [number, number])[] = [
  [1080, 475],
  [920, 372],
];

describe("wave labels on their rings (#128)", () => {
  const focus = [
    [-1, -1],
    [5, -1],
    [-1, 2],
    [11, 13],
  ] as const;

  it("computes angles as atan2 does, to within 2e-5 radians", () => {
    expect(angleOf(0, 0)).toBe(0);
    for (let k = 0; k < 720; k++) {
      const t = (k / 720) * Math.PI * 2 - Math.PI + 1e-3;
      for (const r of [0.5, 3, 250]) {
        const y = Math.sin(t) * r;
        const x = Math.cos(t) * r;
        expect(Math.abs(angleOf(y, x) - Math.atan2(y, x))).toBeLessThan(2e-5);
      }
    }
  });

  it("gives bin angles from straight up, clockwise", () => {
    expect(waveBinAngle(0)).toBeCloseTo(-Math.PI / 2);
    expect(waveBinAngle(WAVE_BINS / 4)).toBeCloseTo(0);
    expect(waveBinAngle(WAVE_BINS / 2)).toBeCloseTo(Math.PI / 2);
  });

  it.each([...SIZES, ...APP_SIZES])(
    "keeps every wave label, centred on its ring, at %ix%i at every time and focus",
    (w, h) => {
      for (const t of TIMES) {
        for (const [selected, hovered] of focus) {
          const drawn = draw(DEMO_GOLDEN, w, h, t, selected, hovered);
          const layout = computeLayout(drawn.scene, w, h);
          for (let wave = 0; wave < drawn.scene.waveCount; wave++) {
            expect([w, h, t, selected, wave, drawn.board.waveShown[wave]]).toEqual([
              w,
              h,
              t,
              selected,
              wave,
              1,
            ]);
            const [l, top, r, b] = waveBox(drawn.board, wave)!.box as number[];
            const cx = (l! + r!) / 2 - layout.cx;
            const cy = (top! + b!) / 2 - layout.cy;
            expect(Math.hypot(cx, cy)).toBeCloseTo(layout.ringRadius[wave]!, 6);
            expect(b! - top!).toBeCloseTo(2 * WAVE_HALF_HEIGHT, 9);
          }
          expect(overlaps(drawn.board)).toEqual([]);
        }
      }
    },
  );

  it.each([...SIZES.filter(([w]) => w > 600), ...APP_SIZES])(
    "never puts a wave label over a node, token arc or beam at %ix%i",
    (w, h) => {
      for (const t of TIMES) {
        for (const [selected, hovered] of focus) {
          const drawn = draw(DEMO_GOLDEN, w, h, t, selected, hovered);
          const layout = computeLayout(drawn.scene, w, h);
          for (let wave = 0; wave < drawn.scene.waveCount; wave++) {
            expect([w, h, t, selected, wave, coveredBy(drawn, layout, wave)]).toEqual([
              w,
              h,
              t,
              selected,
              wave,
              [],
            ]);
          }
        }
      }
    },
  );

  it("covers no node at the narrowest size either, where it may only cover moons", () => {
    for (const t of TIMES) {
      const drawn = draw(DEMO_GOLDEN, 600, 420, t, 5);
      const layout = computeLayout(drawn.scene, 600, 420);
      for (let wave = 0; wave < drawn.scene.waveCount; wave++) {
        expect([
          t,
          wave,
          coveredBy(drawn, layout, wave).filter((s) => s.startsWith("node")),
        ]).toEqual([t, wave, []]);
      }
    }
  });

  it("fixes the reported frames: 1440x900 at t=200, and 1280x800 at t=200 with a5 selected", () => {
    // Before #128, docs-scribe's arc and beams crossed WAVE 2 and WAVE 3 at 1440x900, and at
    // 1280x800 with a5 selected WAVE 3 was dropped for the detail row.
    const a5 = DEMO_GOLDEN.agents.findIndex((a) => a.id === "a5");
    for (const [[w, h], selected] of [
      [APP_SIZES[0]!, -1],
      [APP_SIZES[1]!, a5],
    ] as const) {
      const drawn = draw(DEMO_GOLDEN, w, h, 200, selected);
      const layout = computeLayout(drawn.scene, w, h);
      expect(drawn.scene.waveCount).toBe(4);
      for (let wave = 0; wave < 4; wave++) {
        expect(drawn.board.waveShown[wave]).toBe(1);
        expect(coveredBy(drawn, layout, wave)).toEqual([]);
      }
      expect(selected < 0 || drawn.board.detailWidth[selected]! > 0).toBe(true);
      expect(overlaps(drawn.board)).toEqual([]);
    }
  });

  it("draws wave labels on top of every node, beam and comet, each over a backing", () => {
    const drawn = draw(DEMO_GOLDEN, 1080, 475, 200);
    const ops = drawn.ctx.ops;
    const firstWave = ops.findIndex((o) => o.op === "fillText" && /^WAVE /.test(String(o.args[0])));
    let lastShape = -1;
    ops.forEach((o, k) => {
      if (o.op === "arc" || o.op === "drawImage" || o.op === "stroke") lastShape = k;
    });
    expect(firstWave).toBeGreaterThan(lastShape);
    for (let wave = 0; wave < 4; wave++) {
      const k = ops.findIndex((o) => o.op === "fillText" && o.args[0] === `WAVE ${wave + 1}`);
      const backing = ops
        .slice(0, k)
        .reverse()
        .find((o) => o.op === "fillRect")!;
      const [x, y, bw, bh, color] = backing.args as [number, number, number, number, string];
      expect(color).toBe(DEFAULT_THEME.background);
      expect(x).toBeCloseTo(drawn.board.waveLeft[wave]! - WAVE_PAD_X);
      expect(bw).toBeCloseTo(drawn.res.waveLabels[wave]!.width + 2 * WAVE_PAD_X);
      expect(y + bh / 2).toBeCloseTo(drawn.board.waveBase[wave]! - 3);
    }
  });

  /** A run of frames sharing one set of resources, as the engine draws them while playing. */
  function play(
    w: number,
    h: number,
    from: number,
    to: number,
    stepT: number,
    stepAmbient: number,
    onFrame: (board: LabelBoard, layout: Layout, scene: Scene, k: number) => void,
  ): void {
    const scene = buildScene(DEMO_GOLDEN);
    const layout = computeLayout(scene, w, h);
    const frame = createFrameState(scene);
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    const view: ViewState = { selected: -1, hovered: -1, ambient: 0, dpr: 1 };
    const ctx = new MockContext(false).asDrawContext();
    const timing = { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false };
    let k = 0;
    for (let t = from; t <= to; t += stepT) {
      computeFrameState(scene, t, timing, frame);
      drawFrame(ctx, scene, layout, frame, view, res);
      onFrame(res.board, layout, scene, k++);
      view.ambient += stepAmbient;
    }
  }

  /** True when bin `bin` was blocked for wave `w` when it was placed: same boxes before it. */
  function blockedAtPlacement(board: LabelBoard, layout: Layout, w: number, bin: number): boolean {
    const count = board.boxCount;
    board.boxCount = waveBox(board, w)!.index;
    const blocked = waveBinBlocked(layout, board, w, bin);
    board.boxCount = count;
    return blocked;
  }

  it.each(APP_SIZES)(
    "keeps each wave label where it is until that spot is hit, at %ix%i over a played run",
    (w, h) => {
      const previous: number[] = [];
      let moves = 0;
      let frames = 0;
      let searches = 0;
      const bad: string[] = [];
      play(w, h, 0, DEMO_GOLDEN.totals.duration, 1 / 7.5, 1 / 60, (board, layout, scene) => {
        frames++;
        searches = board.waveSearches;
        for (let wave = 0; wave < scene.waveCount; wave++) {
          const bin = board.waveBin[wave]!;
          const before = previous[wave];
          if (before !== undefined && before >= 0 && bin !== before) {
            moves++;
            // It moved only because its old spot is hit or blocked now, and from a spot that
            // is only hit, to one that is hit less.
            const hitBefore = board.waveHit[wave * WAVE_BINS + before]!;
            const hitAfter = board.waveHit[wave * WAVE_BINS + bin]!;
            const blocked = blockedAtPlacement(board, layout, wave, before);
            if (!blocked && !(hitBefore > 0 && hitAfter < hitBefore)) {
              bad.push(`frame ${frames} wave ${wave}: ${before} (${hitBefore}) to ${bin}`);
            }
          }
          previous[wave] = bin;
        }
      });
      expect(bad).toEqual([]);
      // Agents appear and run during the replay, so some label does have to move.
      expect(moves).toBeGreaterThan(0);
      // At 8x a frame is 1/7.5 replay second; most frames keep every label still.
      expect(frames).toBeGreaterThan(3000);
      expect(moves).toBeLessThan(frames / 20);
      // And most frames only check the spots the labels hold, without scoring every angle.
      expect(searches).toBeLessThan(frames / 10);
    },
  );

  it("fades across to a new spot while the clock runs, and moves at once when paused", () => {
    const scene = buildScene(DEMO_GOLDEN);
    const layout = computeLayout(scene, 1080, 475);
    const frame = computeFrameState(
      scene,
      200,
      { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false },
      createFrameState(scene),
    );
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    const view: ViewState = { selected: -1, hovered: -1, ambient: 10, dpr: 1 };
    const ctx = new MockContext();
    const render = () => {
      ctx.clear();
      drawFrame(ctx.asDrawContext(), scene, layout, frame, view, res);
      return res.board;
    };
    let board = render();
    const wave = 1;
    const row = wave * WAVE_BINS;
    const settled = board.waveBin[wave]!;
    expect(board.waveHit[row + settled]).toBe(0);
    const occupied = Array.from(board.waveHit.subarray(row, row + WAVE_BINS)).findIndex(
      (v) => v > 0,
    );
    expect(occupied).toBeGreaterThanOrEqual(0);

    // Playing: put the label on a hit spot; it leaves it and fades across.
    board.waveBin[wave] = occupied;
    view.ambient += 1 / 60;
    board = render();
    expect(board.waveBin[wave]).not.toBe(occupied);
    expect(board.wavePrevBin[wave]).toBe(occupied);
    expect(board.waveGhostShown[wave]).toBe(1);
    expect(board.waveGhostAlpha[wave]).toBe(1);
    expect(board.waveAlpha[wave]).toBe(0);
    view.ambient += WAVE_FADE_SECONDS / 2;
    board = render();
    expect(board.waveAlpha[wave]).toBeCloseTo(0.5);
    expect(board.waveGhostAlpha[wave]).toBeCloseTo(0.5);
    // Both are drawn while it fades: the old spot fading out, the new one fading in.
    expect(ctx.texts().filter((s) => s === "WAVE 2")).toHaveLength(2);
    view.ambient += WAVE_FADE_SECONDS;
    board = render();
    expect(board.waveAlpha[wave]).toBe(1);
    expect(board.waveGhostShown[wave]).toBe(0);
    expect(ctx.texts().filter((s) => s === "WAVE 2")).toHaveLength(1);

    // Paused (the ambient clock stands still): the move is made at once, with no fade.
    board.waveBin[wave] = occupied;
    board = render();
    expect(board.waveBin[wave]).not.toBe(occupied);
    expect(board.waveGhostShown[wave]).toBe(0);
    expect(board.waveAlpha[wave]).toBe(1);
  });

  it("forgets the angles when the wave labels go, and drops one only with no room at all", () => {
    const { scene, frame } = draw(DEMO_GOLDEN, 1080, 475, 200);
    const board = createLabelBoard(scene.agents.length, scene.waveCount);
    board.agentWidth.fill(60);
    board.agentSize.fill(10.5);
    board.waveWidth.fill(40);
    const roomy = computeLayout(scene, 1080, 475);
    placeLabels(scene, roomy, frame, -1, -1, Infinity, true, board);
    expect(Array.from(board.waveShown.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    // A canvas too small for any label: rings a few pixels across.
    const tiny = computeLayout(scene, 40, 30);
    placeLabels(scene, tiny, frame, -1, -1, Infinity, true, board);
    expect(Array.from(board.waveShown.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(board.waveBin.subarray(0, 4))).toEqual([-1, -1, -1, -1]);
    // No width: no label and no state.
    board.waveWidth.fill(0);
    placeLabels(scene, roomy, frame, -1, -1, Infinity, true, board);
    expect(Array.from(board.waveShown.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it("rules out a spot that leaves the canvas or covers a placed label", () => {
    const { scene } = draw(DEMO_GOLDEN, 1080, 475, 200);
    const layout = computeLayout(scene, 1080, 475);
    const board = createLabelBoard(scene.agents.length, scene.waveCount);
    board.waveWidth.fill(40);
    board.boxCount = 0;
    // Ring 0 straight up is inside the canvas and clear of everything.
    expect(waveBinBlocked(layout, board, 0, 0)).toBe(false);
    // A label box placed right there blocks it.
    const R = layout.ringRadius[0]!;
    board.boxes.set([layout.cx - 5, layout.cy - R - 5, layout.cx + 5, layout.cy - R + 5], 0);
    board.boxCount = 1;
    expect(waveBinBlocked(layout, board, 0, 0)).toBe(true);
    expect(waveBinBlocked(layout, board, 0, WAVE_BINS / 2)).toBe(false);
    // With the centre just below ring 3's top, its top spot leaves the canvas.
    const tight: Layout = { ...layout, cy: layout.ringRadius[3]! + 2 };
    board.boxCount = 0;
    expect(waveBinBlocked(tight, board, 3, 0)).toBe(true);
    expect(waveBinBlocked(tight, board, 3, WAVE_BINS / 2)).toBe(false);
  });
});
