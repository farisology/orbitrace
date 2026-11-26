/**
 * Draw resources: everything the drawing code reuses across frames. Sprites and the star
 * field are built once per engine; gradients once per canvas size; labels on first use.
 */

import type { DrawContext, OrreryEnvironment } from "./context.js";
import { formatDuration } from "./format.js";
import { FONTS, IntLabelCache, Label } from "./labels.js";
import { BUCKET_COUNT, type Palette } from "./theme.js";

export interface Sprite {
  readonly image: CanvasImageSource;
  /** Half the sprite's width; draw at (x - radius, y - radius). */
  readonly radius: number;
}

export interface Sprites {
  /** Glow behind a fresh moon, per colour bucket. */
  readonly moon: readonly Sprite[];
  /** Glow at the tip of a spoke, per colour bucket. */
  readonly flare: readonly Sprite[];
  readonly dispatch: Sprite;
  readonly handback: Sprite;
  readonly haloMain: Sprite;
  readonly haloAgent: Sprite;
}

/** Gradients that depend on the canvas size. */
export interface SizedGradients {
  width: number;
  height: number;
  nebula: (CanvasGradient | null)[];
  vignette: CanvasGradient | null;
  /** Sweep wedge centred on (0, 0); drawn after translate and rotate. */
  sweep: CanvasGradient | null;
}

export interface DrawResources {
  readonly palette: Palette;
  readonly sprites: Sprites | null;
  /** x, y, depth, phase, size per star; x and y from 0 to 1. */
  readonly stars: Float32Array;
  readonly starCount: number;
  readonly gradients: SizedGradients;
  readonly seconds: IntLabelCache;
  readonly durations: IntLabelCache;
  readonly calls: IntLabelCache;
  readonly failures: IntLabelCache;
  readonly separator: Label;
  readonly waveLabels: Label[];
  readonly subagentsLabel: Label;
}

/** Number of background stars. */
export const STAR_COUNT = 240;
export const STAR_STRIDE = 5;

/** Deterministic pseudo-random numbers from 0 to 1 (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStars(count: number, seed = 1): Float32Array {
  const random = seededRandom(seed);
  const stars = new Float32Array(count * STAR_STRIDE);
  for (let i = 0; i < count; i++) {
    const o = i * STAR_STRIDE;
    stars[o] = random();
    stars[o + 1] = random();
    stars[o + 2] = random();
    stars[o + 3] = random() * Math.PI * 2;
    stars[o + 4] = random() * 1.2 + 0.3;
  }
  return stars;
}

/**
 * A soft round glow in any CSS colour: a white radial gradient, then the colour composited
 * with `source-in`, so theme colours need not be hex. `null` when no surface is available.
 */
export function createGlowSprite(
  env: Pick<OrreryEnvironment, "createSurface">,
  color: string,
  radius: number,
): Sprite | null {
  const size = Math.max(2, Math.ceil(radius * 2));
  const surface = env.createSurface(size, size);
  if (surface === null) return null;
  const g = surface.context;
  const gradient = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, "rgba(255,255,255,0.87)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.33)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  g.globalCompositeOperation = "source-over";
  return { image: surface.image, radius };
}

export function createSprites(
  env: Pick<OrreryEnvironment, "createSurface">,
  palette: Palette,
): Sprites | null {
  const moon: Sprite[] = [];
  const flare: Sprite[] = [];
  for (let b = 0; b < BUCKET_COUNT; b++) {
    const color = palette.buckets[b]!;
    const m = createGlowSprite(env, color, 10);
    const f = createGlowSprite(env, color, 13);
    if (m === null || f === null) return null;
    moon.push(m);
    flare.push(f);
  }
  const dispatch = createGlowSprite(env, palette.agent, 26);
  const handback = createGlowSprite(env, palette.handback, 26);
  const haloMain = createGlowSprite(env, palette.main, 78);
  const haloAgent = createGlowSprite(env, palette.agent, 46);
  if (!dispatch || !handback || !haloMain || !haloAgent) return null;
  return { moon, flare, dispatch, handback, haloMain, haloAgent };
}

export function createResources(
  env: Pick<OrreryEnvironment, "createSurface">,
  palette: Palette,
): DrawResources {
  return {
    palette,
    sprites: createSprites(env, palette),
    stars: createStars(STAR_COUNT),
    starCount: STAR_COUNT,
    gradients: { width: -1, height: -1, nebula: [null, null, null], vignette: null, sweep: null },
    seconds: new IntLabelCache(FONTS.small, (n) => `${n}s`),
    // Round down before the cache sees the value, as core's duration formatters do, so an
    // agent's run time on the canvas matches the app's "Ran for" (#86).
    durations: new IntLabelCache(FONTS.small, formatDuration, undefined, Math.floor),
    calls: new IntLabelCache(FONTS.small, (n) => (n === 1 ? "1 call" : `${n} calls`)),
    failures: new IntLabelCache(FONTS.small, (n) => `${n} failed`),
    separator: new Label(" · ", FONTS.small),
    waveLabels: [],
    subagentsLabel: new Label("SUBAGENTS", FONTS.small),
  };
}

/** Label for orbit `wave` (zero-based), created on first use. */
export function waveLabel(resources: DrawResources, wave: number): Label {
  let label = resources.waveLabels[wave];
  if (label === undefined) {
    for (let w = resources.waveLabels.length; w <= wave; w++) {
      resources.waveLabels.push(new Label(`WAVE ${w + 1}`, FONTS.small));
    }
    label = resources.waveLabels[wave]!;
  }
  return label;
}

type ConicCapable = { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient };

/** Rebuild the size-dependent gradients when the canvas size changed. */
export function ensureGradients(
  ctx: DrawContext,
  resources: DrawResources,
  width: number,
  height: number,
  cx: number,
  cy: number,
  base: number,
): SizedGradients {
  const g = resources.gradients;
  if (g.width === width && g.height === height) return g;
  g.width = width;
  g.height = height;
  const radial = (x: number, y: number, r: number, rgb: string, alpha: number) => {
    if (!(r > 0)) return null;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    return gradient;
  };
  // Brand ion and wire violet from design/tokens.json, as rgb triples.
  g.nebula[0] = radial(cx + base * 1.1, cy - base * 0.9, base * 2.4, "110,149,255", 0.11);
  g.nebula[1] = radial(cx - base * 1.3, cy + base * 0.9, base * 2.1, "180,140,255", 0.08);
  g.nebula[2] = radial(cx, cy, base * 1.1, "110,149,255", 0.09);
  const outer = Math.max(width, height) * 0.8;
  if (outer > base * 1.4 && base > 0) {
    const vignette = ctx.createRadialGradient(cx, cy, base * 1.4, cx, cy, outer);
    vignette.addColorStop(0, "rgba(6,7,20,0)");
    vignette.addColorStop(1, "rgba(6,7,20,0.9)");
    g.vignette = vignette;
  } else {
    g.vignette = null;
  }
  const conic = (ctx as unknown as ConicCapable).createConicGradient;
  if (typeof conic === "function") {
    const sweep = conic.call(ctx, -0.5, 0, 0);
    sweep.addColorStop(0, "rgba(110,149,255,0)");
    sweep.addColorStop(0.079, "rgba(110,149,255,0.08)");
    sweep.addColorStop(0.08, "rgba(110,149,255,0)");
    sweep.addColorStop(1, "rgba(110,149,255,0)");
    g.sweep = sweep;
  } else {
    g.sweep = null;
  }
  return g;
}
