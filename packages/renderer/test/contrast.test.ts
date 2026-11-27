/**
 * #117: contrast of canvas text. Every label is drawn over a backing box in the background
 * colour; its opacity comes from the theme so that the text keeps 4.5:1 against the backing
 * composited over anything at all, black to white (white standing for stacked glows, comet
 * heads, the white effort core and the starfield). Checked by calculation from the theme
 * values, and on drawn frames: every `fillText` of the demo golden, at several sizes, times and
 * selections, is matched with the backing drawn under it.
 */

import type { ReplayModel } from "@orbitrace/core";
import { beforeAll, describe, expect, it } from "vitest";
import { scaledReplay } from "../demo/sessions.js";
import {
  BLACK,
  CONTRAST_FLOOR,
  CONTRAST_TARGET,
  WHITE,
  backingAlphas,
  contrastRatio,
  minBackingAlpha,
  mixOver,
  parseColor,
  relativeLuminance,
  worstContrastOverBacking,
  type Rgba,
} from "../src/contrast.js";
import { drawFrame, type ViewState } from "../src/draw.js";
import { DESIGN_COLORS } from "../src/generated/design.js";
import { computeLayout } from "../src/layout.js";
import { createResources } from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import {
  DEFAULT_THEME,
  MIN_BACKING_ALPHA,
  backingAlpha,
  canvasTextColors,
  createPalette,
} from "../src/theme.js";
import { EFFECT_SECONDS, computeFrameState, createFrameState } from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { MockContext, mockSurfaces, type Op } from "./support/mock-context.js";

const ratio = (a: string, b: string): number =>
  contrastRatio(relativeLuminance(parseColor(a)!), relativeLuminance(parseColor(b)!));

describe("colour parsing and WCAG ratios", () => {
  it("parses hex and rgb() colours and rejects the rest", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0008")).toEqual({ r: 0, g: 0, b: 0, a: 136 / 255 });
    expect(parseColor(" #060714 ")).toEqual({ r: 6, g: 7, b: 20, a: 1 });
    expect(parseColor("#11223380")).toEqual({ r: 17, g: 34, b: 51, a: 128 / 255 });
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(100% 0% 50% / 25%)")).toEqual({ r: 255, g: 0, b: 127.5, a: 0.25 });
    expect(parseColor("rebeccapurple")).toBeNull();
    expect(parseColor("hsl(10 20% 30%)")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor("rgb(a, b, c)")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });

  it("matches the ratios design/identity.md lists for the tokens", () => {
    expect(ratio(DESIGN_COLORS.text, DESIGN_COLORS.void)).toBeCloseTo(16.32, 2);
    expect(ratio(DESIGN_COLORS.faint, DESIGN_COLORS.void)).toBeCloseTo(6.47, 2);
    expect(ratio(DESIGN_COLORS.dim, DESIGN_COLORS.rim)).toBeCloseTo(5.6, 2);
    expect(ratio(DESIGN_COLORS.rim, DESIGN_COLORS.void)).toBeCloseTo(1.42, 2);
    expect(contrastRatio(relativeLuminance(WHITE), relativeLuminance(BLACK))).toBeCloseTo(21, 6);
    expect(contrastRatio(0.2, 0.2)).toBe(1);
  });

  it("composites a colour over another as canvas does, per sRGB channel", () => {
    const back = parseColor("#060714")!;
    expect(mixOver(back, 1, WHITE)).toEqual({ ...back, a: 1 });
    expect(mixOver(back, 0, WHITE)).toEqual(WHITE);
    const half = mixOver({ r: 0, g: 100, b: 200, a: 0.5 }, 1, BLACK);
    expect([half.r, half.g, half.b]).toEqual([0, 50, 100]);
  });
});

describe("backing opacity", () => {
  const back = parseColor(DESIGN_COLORS.void)!;
  const faint = parseColor(DESIGN_COLORS.faint)!;

  it("finds the worst background behind a backing: white for light text", () => {
    // Opaque backing: just text on the backing.
    expect(worstContrastOverBacking(faint, back, 1)).toBeCloseTo(6.47, 2);
    // No backing: some background matches the text, so there is no floor at all.
    expect(worstContrastOverBacking(faint, back, 0)).toBe(1);
    // A strong backing over white is the worst case for light text.
    const over = relativeLuminance(mixOver(back, 0.9, WHITE));
    expect(worstContrastOverBacking(faint, back, 0.9)).toBeCloseTo(
      contrastRatio(relativeLuminance(faint), over),
      6,
    );
    // Mid-grey text sits inside the range a thin backing allows: some background matches it.
    const grey: Rgba = { r: 128, g: 128, b: 128, a: 1 };
    expect(worstContrastOverBacking(grey, back, 0.2)).toBe(1);
  });

  it("picks the least opacity that reaches the target, rounded up to a hundredth", () => {
    const alpha = minBackingAlpha(faint, back);
    expect(worstContrastOverBacking(faint, back, alpha)).toBeGreaterThanOrEqual(CONTRAST_TARGET);
    expect(worstContrastOverBacking(faint, back, alpha - 0.01)).toBeLessThan(CONTRAST_TARGET);
    expect(minBackingAlpha(faint, back, CONTRAST_TARGET, 0.95)).toBe(0.95);
    // Text too close to the background to reach the target even on an opaque backing.
    expect(minBackingAlpha(parseColor("#101020")!, back)).toBe(1);
  });

  it("maps each text colour to an opacity, opaque for colours it cannot read", () => {
    const map = backingAlphas(DESIGN_COLORS.void, ["#E4E7FA", "#E4E7FA", "tomato", "#FFF8"], 0.5);
    expect(map.size).toBe(3);
    expect(map.get("#E4E7FA")).toBeGreaterThanOrEqual(0.5);
    expect(map.get("tomato")).toBe(1);
    expect(map.get("#FFF8")).toBe(1);
    expect(backingAlphas("transparent", ["#E4E7FA"], 0).get("#E4E7FA")).toBe(1);
  });
});

describe("every kind of canvas text against the floor, from the theme values", () => {
  const palette = createPalette(DEFAULT_THEME);
  const back = parseColor(palette.background)!;

  it("keeps 4.5:1 over a backing composited over black or white", () => {
    const rows: string[] = [];
    for (const { kind, color } of canvasTextColors(palette)) {
      const alpha = backingAlpha(palette, color);
      const text = parseColor(color)!;
      const worst = worstContrastOverBacking(text, back, alpha);
      const before = worstContrastOverBacking(text, back, MIN_BACKING_ALPHA);
      rows.push(
        `${kind}: ${color}, backing ${alpha.toFixed(2)}, worst ${worst.toFixed(2)}:1 ` +
          `(at the old 0.72 backing: ${before.toFixed(2)}:1)`,
      );
      expect([kind, worst >= CONTRAST_FLOOR]).toEqual([kind, true]);
      expect(alpha).toBeGreaterThanOrEqual(MIN_BACKING_ALPHA);
    }
    console.log(rows.join("\n"));
  });

  it("gives an opaque backing for a colour the palette does not list", () => {
    expect(backingAlpha(palette, "#123456")).toBe(1);
  });

  it("raises the backing for a theme whose colours need it", () => {
    const pale = createPalette({ ...DEFAULT_THEME, failure: "#FF0000" });
    const red = parseColor("#FF0000")!;
    expect(
      worstContrastOverBacking(red, back, backingAlpha(pale, "#FF0000")),
    ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });
});

/** The text drawn in a frame, with its colour, opacity and the backing found under it. */
interface DrawnText {
  text: string;
  color: string;
  alpha: number;
  backing: number;
}

/** Walk the recorded ops, tracking fill style and opacity, and pair each text with its box. */
function textsWithBackings(ops: readonly Op[], background: string): DrawnText[] {
  let fill: unknown = "#000";
  let alpha = 1;
  const boxes: { x: number; y: number; w: number; h: number; alpha: number }[] = [];
  const out: DrawnText[] = [];
  for (const o of ops) {
    if (o.op === "set:fillStyle") fill = o.args[0];
    else if (o.op === "set:globalAlpha") alpha = o.args[0] as number;
    else if (o.op === "fillRect" && o.args[4] === background) {
      const [x, y, w, h] = o.args as number[];
      boxes.push({ x: x!, y: y!, w: w!, h: h!, alpha });
    } else if (o.op === "fillText") {
      const [text, x, y] = o.args as [string, number, number];
      // The latest background box covering the start of the text's x-height.
      let backing = 0;
      for (let k = boxes.length - 1; k >= 0; k--) {
        const b = boxes[k]!;
        if (x + 1 >= b.x && x + 1 <= b.x + b.w && y - 2 >= b.y && y - 2 <= b.y + b.h) {
          backing = b.alpha;
          break;
        }
      }
      out.push({ text, color: String(fill), alpha, backing });
    }
  }
  return out;
}

describe("every text in drawn frames keeps the floor", () => {
  const models = new Map<string, ReplayModel>();
  beforeAll(async () => {
    models.set("demo", DEMO_GOLDEN);
    models.set("500 agents", await scaledReplay(500));
  });

  function drawnTexts(m: ReplayModel, w: number, h: number, t: number, selected: number) {
    const scene = buildScene(m);
    const layout = computeLayout(scene, w, h);
    const frame = computeFrameState(
      scene,
      t,
      { speed: 8, minVisibleCallSeconds: 0.3, reducedMotion: false },
      createFrameState(scene),
    );
    const palette = createPalette(DEFAULT_THEME);
    const res = createResources(mockSurfaces(), palette);
    const view: ViewState = { selected, hovered: selected > 0 ? 1 : -1, ambient: 0, dpr: 1 };
    const ctx = new MockContext();
    drawFrame(ctx.asDrawContext(), scene, layout, frame, view, res);
    return { texts: textsWithBackings(ctx.ops, palette.background), palette, scene, frame };
  }

  it("measures every fillText against its backing over black or white", () => {
    const allowed = new Set(canvasTextColors(createPalette(DEFAULT_THEME)).map((e) => e.color));
    const seen = new Set<string>();
    const demo = buildScene(DEMO_GOLDEN);
    // The middle of the demo's idle-skip warp at 8x, when its label is at full strength.
    const warpPeak = demo.warpAt[0]! + (EFFECT_SECONDS.warp * 8) / 2;
    const cases: [string, number, number, number, number][] = [];
    for (const [w, h] of [
      [1080, 475],
      [920, 372],
      [1920, 1080],
      [600, 420],
    ] as const) {
      for (const t of [30, 120, 200, 300, 345, warpPeak, 500, DEMO_GOLDEN.totals.duration]) {
        for (const selected of [-1, 5, 9]) cases.push(["demo", w, h, t, selected]);
      }
    }
    const big = models.get("500 agents")!;
    for (const f of [0.4, 0.8, 1])
      cases.push(["500 agents", 1280, 800, big.totals.duration * f, 7]);

    let checked = 0;
    for (const [name, w, h, t, selected] of cases) {
      const { texts, palette } = drawnTexts(models.get(name)!, w, h, t, selected);
      const back = parseColor(palette.background)!;
      for (const d of texts) {
        // Still frames: nothing is fading, so every text is drawn at full opacity.
        expect([name, w, h, t, d.text, d.alpha]).toEqual([name, w, h, t, d.text, 1]);
        expect([d.text, allowed.has(d.color)]).toEqual([d.text, true]);
        const worst = worstContrastOverBacking(parseColor(d.color)!, back, d.backing);
        expect([name, w, h, t, d.text, d.color, worst >= CONTRAST_FLOOR]).toEqual([
          name,
          w,
          h,
          t,
          d.text,
          d.color,
          true,
        ]);
        seen.add(d.color);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    // The frames cover the light, dim and faint text and at least one spoke-tag colour.
    for (const c of [DESIGN_COLORS.text, DESIGN_COLORS.dim, DESIGN_COLORS.faint]) {
      expect(seen.has(c)).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(3);
  });
});
