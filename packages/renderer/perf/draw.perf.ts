/**
 * Draw-path benchmark in Node: `computeFrameState` + `drawFrame` for sessions of 15, 100 and
 * 500 agents made by the fixtures generator and core's real pipeline (demo/sessions.ts).
 *
 * Two contexts:
 * - a no-op context: the JavaScript cost of a frame, with no canvas behind it;
 * - a counting context: how many canvas calls a frame makes (arcs, text, sprites), the work a
 *   browser does on top of the JavaScript. Node has no canvas, so this is the stand-in for
 *   raster cost; `npm run bench:browser` measures a real canvas in headless Chrome.
 *
 * Prints one JSON report. Asserts only that the numbers exist, so it never fails on a slow
 * machine; the budget is checked by reading the report (docs/performance.md).
 */

import { cpus, totalmem } from "node:os";
import type { ReplayModel } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { demoReplay, scaledReplay } from "../demo/sessions.js";
import { drawFrame, type ViewState } from "../src/draw.js";
import { computeLayout } from "../src/layout.js";
import { lodFor } from "../src/lod.js";
import { createResources } from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import { computeFrameState, createFrameState } from "../src/timeline.js";
import { MockContext, mockSurfaces } from "../test/support/mock-context.js";
import { COUNTED, CountingContext } from "./counting-context.js";

const WIDTH = 1080;
const HEIGHT = 530;
const FRAMES = 1200;
/** The whole session plays in this many real seconds, as a fast replay would. */
const PLAY_SECONDS = 30;

const quantile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

const round = (n: number, digits = 3): number => Number(n.toFixed(digits));

function sweep(model: ReplayModel, ctx: MockContext | CountingContext, onFrame?: () => void) {
  const scene = buildScene(model);
  const layout = computeLayout(scene, WIDTH, HEIGHT);
  const frame = createFrameState(scene);
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const view: ViewState = { selected: -1, hovered: -1, ambient: 0, dpr: 2 };
  const timing = {
    speed: scene.duration / PLAY_SECONDS,
    minVisibleCallSeconds: 0.3,
    reducedMotion: false,
  };
  const draw = ctx.asDrawContext();
  const times = new Float64Array(FRAMES);
  for (let k = 0; k < FRAMES; k++) {
    const t = (scene.duration * k) / (FRAMES - 1);
    view.ambient = k / 60;
    const start = performance.now();
    computeFrameState(scene, t, timing, frame);
    drawFrame(draw, scene, layout, frame, view, res);
    times[k] = performance.now() - start;
    onFrame?.();
  }
  return { scene, times };
}

describe("draw path at 15, 100 and 500 agents", () => {
  it("reports frame time and canvas calls per frame", async () => {
    const report: Record<string, unknown>[] = [];
    for (const agents of [15, 100, 500]) {
      const model = agents === 15 ? await demoReplay() : await scaledReplay(agents);
      const noop = new MockContext(false);
      for (let w = 0; w < 3; w++) sweep(model, noop);
      const { scene, times } = sweep(model, noop);
      const sorted = [...times].sort((a, b) => a - b);

      const counting = new CountingContext();
      const totals: number[] = [];
      const peak: Record<string, number> = {};
      sweep(model, counting, () => {
        totals.push(counting.total());
        for (const key of COUNTED) peak[key] = Math.max(peak[key] ?? 0, counting.counts[key]);
        counting.reset();
      });
      totals.sort((a, b) => a - b);
      report.push({
        agents: model.agents.length,
        toolCalls: model.totals.toolCalls,
        waves: scene.waveCount,
        lod: lodFor(model.agents.length),
        jsFrameMs: {
          median: round(quantile(sorted, 0.5)),
          p95: round(quantile(sorted, 0.95)),
          max: round(sorted[sorted.length - 1] ?? 0),
        },
        canvasCallsPerFrame: { median: quantile(totals, 0.5), max: totals[totals.length - 1] },
        peakCallsPerFrame: peak,
      });
      expect(times.length).toBe(FRAMES);
    }
    console.log(
      JSON.stringify(
        {
          bench: "draw-node",
          node: process.version,
          cpu: cpus()[0]?.model,
          cores: cpus().length,
          memoryGB: round(totalmem() / 2 ** 30, 1),
          canvas: `${WIDTH}x${HEIGHT}`,
          frames: FRAMES,
          playSeconds: PLAY_SECONDS,
          cases: report,
        },
        null,
        2,
      ),
    );
  });
});
