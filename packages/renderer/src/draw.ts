/**
 * Drawing: paints one frame from a scene, a layout and a frame state. Takes any
 * `DrawContext`, so tests pass a recording mock. The hot path allocates nothing: every
 * array is preallocated, every label is cached, every gradient and sprite is reused.
 *
 * Order: backdrop, tethers, agents, comets, the vignette, then every label in one pass on top
 * (wave labels, then agent labels), at the spots label-layout.ts chose so that none overlap and
 * no wave label sits under a node, arc or beam (#128), then the warp label. Every label has a
 * backing box whose opacity keeps its text at 4.5:1 over anything behind it (contrast.ts,
 * #117). The level of detail (lod.ts) decides what is left out above 100 agents.
 */

import { toRealSeconds } from "@orbitrace/core";
import type { DrawContext } from "./context.js";
import { WHITE_CORE } from "./generated/design.js";
import {
  WAVE_BASELINE_DROP,
  WAVE_HALF_HEIGHT,
  WAVE_PAD_X,
  placeLabels,
  type LabelBoard,
} from "./label-layout.js";
import { measureLabel, type Label } from "./labels.js";
import type { Layout } from "./layout.js";
import {
  LABEL_BUDGET,
  drawsMoonGlow,
  drawsMoons,
  drawsSpokeTags,
  labelsAvoidNodes,
  markCollapsedWaves,
} from "./lod.js";
import {
  ensureBoard,
  ensureGradients,
  waveLabel,
  STAR_STRIDE,
  type DrawResources,
} from "./resources.js";
import type { AgentScene, Scene } from "./scene.js";
import { innerScale, traceShape } from "./shapes.js";
import { BUCKET_COUNT, BUCKET_FAILURE, backingAlpha } from "./theme.js";
import {
  EFFECT_SECONDS,
  PHASE_ACTIVE,
  PHASE_DONE,
  PHASE_QUEUED,
  type FrameState,
} from "./timeline.js";

/** What the engine knows besides the model and the time. */
export interface ViewState {
  /** Selected agent index, or -1. */
  selected: number;
  /** Hovered agent index, or -1. */
  hovered: number;
  /** Seconds of ambient motion (stars, dashes, breathing). Frozen while paused or reduced. */
  ambient: number;
  /** Device pixel ratio of the backing store. */
  dpr: number;
}

/** At most this many moons are drawn per agent (the most recent calls). */
export const MAX_MOONS_PER_AGENT = 400;
const TAU = Math.PI * 2;
const NO_DASH: number[] = [];
const TETHER_DASH = [3, 7];
const RING_DASH = [2, 6];
const ORBIT_DASH = [2, 5];
/** Bend of tether and comet curves, as a fraction of their length. */
const BEND = 0.16;
/** Scratch point for curve evaluation: [x, y, controlX, controlY]. */
const point = new Float64Array(4);

/** Point at `p` on the tether curve from (x0, y0) to (x1, y1), written into `out`. */
export function curvePoint(
  p: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Float64Array = point,
): Float64Array {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const px = (x0 + x1) / 2 - dy * BEND;
  const py = (y0 + y1) / 2 + dx * BEND;
  const u = 1 - p;
  out[0] = u * u * x0 + 2 * u * p * px + p * p * x1;
  out[1] = u * u * y0 + 2 * u * p * py + p * p * y1;
  out[2] = px;
  out[3] = py;
  return out;
}

/** Paint one frame. With `scene` null, paints the empty background only. */
export function drawFrame(
  ctx: DrawContext,
  scene: Scene | null,
  layout: Layout,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
): void {
  const pal = res.palette;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.setLineDash(NO_DASH);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = pal.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  if (scene === null || layout.width <= 0 || layout.height <= 0) return;

  // Only on a size change: called every frame, this helper would be optimised late, on a frame
  // well into playback, and the compile allocates on that frame (#158).
  const sized = res.gradients;
  if (sized.width !== layout.width || sized.height !== layout.height) {
    ensureGradients(ctx, res, layout.width, layout.height, layout.cx, layout.cy, layout.base);
  }
  const board = ensureBoard(res, scene.agents.length, scene.waveCount);
  markCollapsedWaves(scene, frame, scene.lod, board.waveCollapsed, board.waveOpen);
  prepareLabels(ctx, scene, layout, frame, view, res, board);
  placeLabels(
    scene,
    layout,
    frame,
    view.selected,
    view.hovered,
    LABEL_BUDGET[scene.lod] ?? 0,
    labelsAvoidNodes(scene.lod),
    board,
    view.ambient,
  );
  drawBackdrop(ctx, layout, frame, view, res, board);
  drawTethers(ctx, scene, layout, frame, view, res, board);
  // Subagents first, the main agent last so it sits on top.
  for (let i = 1; i < scene.agents.length; i++) {
    if (collapsedAgent(scene, board, view, i)) continue;
    drawAgent(ctx, scene, scene.agents[i]!, layout, frame, view, res);
  }
  drawCollapsedAgents(ctx, scene, layout, view, res, board);
  drawAgent(ctx, scene, scene.agents[0]!, layout, frame, view, res);
  drawComets(ctx, scene, layout, frame, res);

  // The vignette darkens the edges before the labels, so it never dims their text (#117).
  const g = res.gradients;
  if (g.vignette !== null) {
    ctx.fillStyle = g.vignette;
    ctx.fillRect(0, 0, layout.width, layout.height);
  }
  drawWaveLabels(ctx, scene, layout, res, board);
  drawLabels(ctx, scene, frame, view, res, board);
  if (frame.warpIndex >= 0 && frame.warpFactor > 0.02) {
    const label = (layout.wide ? scene.warpLabel : scene.warpLabelNarrow)[frame.warpIndex];
    if (label !== undefined) {
      const w = measureLabel(ctx, label);
      const size = label.font.size;
      const left = layout.cx - w / 2;
      const base = layout.cy - layout.base * 0.36;
      // Its backing, like every label's, fades with it.
      ctx.globalAlpha = frame.warpFactor * backingAlpha(pal, pal.text);
      ctx.fillStyle = pal.background;
      ctx.fillRect(left - 6, base - size, w + 12, size + 6);
      ctx.globalAlpha = frame.warpFactor;
      ctx.fillStyle = pal.text;
      ctx.fillText(label.text, left, base);
      ctx.globalAlpha = 1;
    }
  }
}

function drawBackdrop(
  ctx: DrawContext,
  layout: Layout,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
  board: LabelBoard,
): void {
  const pal = res.palette;
  const { width: W, height: H, cx, cy, base } = layout;
  const g = res.gradients;

  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < g.nebula.length; i++) {
    const gradient = g.nebula[i];
    if (gradient) {
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Stars, streaked outwards during a warp.
  const real = frame.reducedMotion ? 0 : view.ambient;
  const warp = frame.warpFactor;
  const stars = res.stars;
  ctx.fillStyle = pal.text;
  for (let i = 0; i < res.starCount; i++) {
    const o = i * STAR_STRIDE;
    const z = stars[o + 2]!;
    const size = stars[o + 4]! * (0.45 + z * 0.6) * 1.6;
    const x = ((stars[o]! + real * 0.003 * (0.2 + z)) % 1) * W;
    const y = stars[o + 1]! * H;
    const twinkle = 0.55 + 0.45 * Math.sin(real * (0.6 + z) + stars[o + 3]!);
    ctx.globalAlpha = (0.12 + z * 0.55) * twinkle;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
  }
  if (warp > 0.02) {
    ctx.strokeStyle = pal.text;
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.6 * warp;
    ctx.beginPath();
    for (let i = 0; i < res.starCount; i++) {
      const o = i * STAR_STRIDE;
      const z = stars[o + 2]!;
      const x = ((stars[o]! + real * 0.003 * (0.2 + z)) % 1) * W;
      const y = stars[o + 1]! * H;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const length = warp * (18 + z * 70);
      ctx.moveTo(x, y);
      ctx.lineTo(x + (dx / d) * length, y + (dy / d) * length);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  // Polar grid, wave orbits and bezel.
  const bezel = base * 1.22;
  ctx.lineWidth = 1;
  ctx.strokeStyle = pal.rim;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(cx - bezel, cy);
  ctx.lineTo(cx + bezel, cy);
  ctx.moveTo(cx, cy - bezel);
  ctx.lineTo(cx, cy + bezel);
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(cx + base * 0.28, cy);
  ctx.arc(cx, cy, base * 0.28, 0, TAU);
  ctx.moveTo(cx + base * 0.78, cy);
  ctx.arc(cx, cy, base * 0.78, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = pal.rimHi;
  ctx.setLineDash(RING_DASH);
  ctx.beginPath();
  let collapsed = 0;
  for (let i = 0; i < layout.ringCount; i++) {
    const R = layout.ringRadius[i]!;
    if (board.waveCollapsed[i] === 1) {
      collapsed++;
      continue;
    }
    ctx.moveTo(cx + R, cy);
    ctx.arc(cx, cy, R, 0, TAU);
  }
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
  // Ring summaries (lod.ts): a finished wave is one solid orbit.
  if (collapsed > 0) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < layout.ringCount; i++) {
      if (board.waveCollapsed[i] !== 1) continue;
      const R = layout.ringRadius[i]!;
      ctx.moveTo(cx + R, cy);
      ctx.arc(cx, cy, R, 0, TAU);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  ctx.beginPath();
  ctx.moveTo(cx + bezel, cy);
  ctx.arc(cx, cy, bezel, 0, TAU);
  for (let i = 0; i < 72; i++) {
    const a = (i * Math.PI) / 36;
    const tick = i % 6 === 0 ? 9 : 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ctx.moveTo(cx + c * bezel, cy + s * bezel);
    ctx.lineTo(cx + c * (bezel + tick), cy + s * (bezel + tick));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // The sweep turns with replay time, so it is still in a still frame and omitted when reduced.
  if (!frame.reducedMotion) {
    const angle = frame.t * 0.11;
    if (g.sweep !== null) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.fillStyle = g.sweep;
      ctx.beginPath();
      ctx.arc(0, 0, bezel, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.strokeStyle = pal.main;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * bezel, cy + Math.sin(angle) * bezel);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawTethers(
  ctx: DrawContext,
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
  board: LabelBoard,
): void {
  const pal = res.palette;
  const mx = layout.x[0]!;
  const my = layout.y[0]!;
  const lead = frame.reducedMotion ? 0 : EFFECT_SECONDS.comet * frame.speed;
  ctx.lineWidth = 1;
  // Two batched passes: running agents (dashed, flowing) and the rest (faint, solid).
  for (let pass = 0; pass < 2; pass++) {
    const running = pass === 0;
    let any = false;
    ctx.beginPath();
    for (let i = 1; i < scene.agents.length; i++) {
      const a = scene.agents[i]!;
      if (frame.t < a.start - lead) continue;
      if ((frame.phase[i] === PHASE_ACTIVE) !== running) continue;
      if (collapsedAgent(scene, board, view, i)) continue;
      const x = layout.x[i]!;
      const y = layout.y[i]!;
      curvePoint(0.5, mx, my, x, y);
      ctx.moveTo(mx, my);
      ctx.quadraticCurveTo(point[2]!, point[3]!, x, y);
      any = true;
    }
    if (!any) continue;
    if (running) {
      ctx.strokeStyle = pal.agent;
      ctx.globalAlpha = 0.4;
      ctx.setLineDash(TETHER_DASH);
      ctx.lineDashOffset = frame.reducedMotion ? 0 : -view.ambient * 14;
    } else {
      ctx.strokeStyle = pal.rimHi;
      ctx.globalAlpha = 0.3;
    }
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineDashOffset = 0;
  }
  ctx.globalAlpha = 1;
}

function drawAgent(
  ctx: DrawContext,
  scene: Scene,
  a: AgentScene,
  layout: Layout,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
): void {
  const i = a.index;
  const phase = frame.phase[i]!;
  if (!a.isMain && phase === PHASE_QUEUED) return;
  const pal = res.palette;
  const t = frame.t;
  const speed = frame.speed;
  const reduced = frame.reducedMotion;
  const active = phase === PHASE_ACTIVE;
  const done = phase === PHASE_DONE;
  const color = a.isMain ? pal.main : pal.agent;
  const x = layout.x[i]!;
  const y = layout.y[i]!;
  const r = layout.r[i]!;
  const ro = layout.ro[i]!;
  const dir = a.isMain ? 1 : -1;
  const sprites = res.sprites;
  const selected = view.selected === i;
  const hovered = view.hovered === i;

  // Moons: calls whose spoke is over, batched into one path per colour. Above 100 agents the
  // level of detail leaves some out (lod.ts); the call count stays in the detail row.
  const lod = scene.lod;
  const started = drawsMoons(lod, phase, selected || hovered) ? frame.started[i]! : 0;
  const moonGlow = drawsMoonGlow(lod);
  const first = Math.max(0, started - MAX_MOONS_PER_AGENT);
  const rotation = reduced ? 0 : t * 0.006 * dir;
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const fresh = EFFECT_SECONDS.moonFresh * speed;
  for (let b = 0; b < BUCKET_COUNT; b++) {
    let any = false;
    const radius = b === BUCKET_FAILURE ? 2.1 : 1.5;
    ctx.beginPath();
    for (let j = first; j < started; j++) {
      if (a.toolBucket[j] !== b || a.toolSkip[j] === 1) continue;
      const end = a.toolEnd[j]!;
      const shownUntil = Math.max(end, a.toolStart[j]! + frame.minVisible);
      if (shownUntil > t) continue;
      const c = a.moonCos[j]!;
      const s = a.moonSin[j]!;
      const rr = ro + a.moonRing[j]!;
      const mx = x + (c * cosR - s * sinR) * rr;
      const my = y + (s * cosR + c * sinR) * rr;
      if (moonGlow && !reduced && sprites !== null) {
        const age = (t - shownUntil) / fresh;
        if (age < 1) {
          const glow = sprites.moon[b]!;
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 1 - age;
          ctx.drawImage(glow.image, mx - glow.radius, my - glow.radius);
          ctx.globalCompositeOperation = "source-over";
        }
      }
      ctx.moveTo(mx + radius, my);
      ctx.arc(mx, my, radius, 0, TAU);
      any = true;
    }
    if (any) {
      ctx.globalAlpha = done ? 0.4 : 0.85;
      ctx.fillStyle = pal.buckets[b]!;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Spokes: calls in flight.
  let labelled = drawsSpokeTags(lod) ? 0 : 2;
  const from = frame.flightOffset[i]!;
  const to = frame.flightOffset[i + 1]!;
  for (let k = from; k < to; k++) {
    const j = frame.flightTool[k]!;
    // A failure shows only once the result is in; until then the call has its kind's colour.
    const b = t >= a.toolEnd[j]! ? a.toolBucket[j]! : a.toolKindBucket[j]!;
    const fc = pal.buckets[b]!;
    const angle = a.isMain ? a.flareAngle[j]! : layout.angle[i]! + a.flareAngle[j]!;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const r0 = ro + 7;
    const reach = r0 + a.flareLength[j]! * frame.flightGrow[k]!;
    const x2 = x + c * reach;
    const y2 = y + s * reach;
    const alpha = frame.flightAlpha[k]! * 0.9;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = fc;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x + c * r0, y + s * r0);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (sprites !== null) {
      const glow = sprites.flare[b]!;
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(glow.image, x2 - glow.radius, y2 - glow.radius);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.fillStyle = fc;
    ctx.beginPath();
    ctx.arc(x2, y2, b === BUCKET_FAILURE ? 3 : 2.1, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (layout.wide && labelled < 2 && frame.flightRunning[k] === 1) {
      const startT = a.toolStart[j]!;
      const long = a.toolOpen[j] === 1 || a.toolEnd[j]! - startT > 3;
      if (long) {
        const name = a.toolLabel[j]!;
        const secs = res.seconds.get(t - startT);
        drawTagRow(ctx, layout, res, x2 + c * 22, y2 + s * 10 + 3, name, secs, null, null, fc);
        labelled++;
      }
    }
  }

  // Halo while running.
  if (active && sprites !== null) {
    const halo = a.isMain ? sprites.haloMain : sprites.haloAgent;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = reduced ? 0.6 : 0.55 + 0.15 * Math.sin(view.ambient * 2 + a.seed);
    ctx.drawImage(halo.image, x - halo.radius, y - halo.radius);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // Reply pulses: a ring per recent reply. Replies are in time order, so stop at the first old one.
  if (!reduced) {
    const pulse = EFFECT_SECONDS.pulse * speed;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    for (let k = frame.replies[i]! - 1; k >= 0; k--) {
      const p = (t - a.replyT[k]!) / pulse;
      if (p >= 1) break;
      ctx.globalAlpha = (1 - p) * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, ro + 1 + p * 13, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Spawn flash.
  const spawn = frame.spawn[i]!;
  if (spawn >= 0) {
    ctx.strokeStyle = pal.agent;
    ctx.globalAlpha = 1 - spawn;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + spawn * 34, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Body: outline is the family, inner fill is the effort.
  ctx.lineJoin = "round";
  ctx.fillStyle = done ? pal.nodeFillDone : pal.nodeFill;
  traceShape(ctx, a.shape, x, y, r);
  ctx.fill();
  ctx.strokeStyle = done ? pal.rimHi : color;
  ctx.lineWidth = a.isMain ? 2 : 1.5;
  ctx.stroke();

  if (active) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash(ORBIT_DASH);
    ctx.lineDashOffset = reduced ? 0 : -view.ambient * 8 * dir;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, ro + 6.5, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineDashOffset = 0;
    ctx.globalAlpha = 1;
  }

  // Token arc: output tokens so far, relative to the busiest agent.
  const arc = frame.arc[i]!;
  if (arc > 0) {
    ctx.strokeStyle = pal.tokenArc;
    ctx.lineWidth = 2.4;
    ctx.globalAlpha = done ? 0.5 : 1;
    ctx.beginPath();
    ctx.arc(x, y, ro + 3, -Math.PI / 2, -Math.PI / 2 + arc * TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  if (a.fill > 0) {
    traceShape(ctx, a.shape, x, y, r * innerScale(a.fill));
    ctx.fillStyle = done ? pal.faint : color;
    ctx.globalAlpha = done ? 0.55 : 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (a.maxEffort && !done) {
      ctx.fillStyle = pal.white;
      ctx.beginPath();
      ctx.arc(x + a.shape.coreX * r, y + a.shape.coreY * r, WHITE_CORE.radius * r, 0, TAU);
      ctx.fill();
    }
  }

  // Reticle on the selected and hovered agent.
  if (selected || hovered) {
    ctx.strokeStyle = selected ? pal.text : pal.dim;
    ctx.lineWidth = 1.4;
    const rr = ro + 29;
    const spin = reduced ? 0 : view.ambient * 0.4;
    for (let q = 0; q < 4; q++) {
      const a0 = spin + (q * Math.PI) / 2;
      ctx.beginPath();
      ctx.arc(x, y, rr, a0, a0 + 0.5);
      ctx.stroke();
    }
  }
}

/** True when agent `i` is drawn as a dot of a ring summary (lod.ts), not as a full node. */
function collapsedAgent(scene: Scene, board: LabelBoard, view: ViewState, i: number): boolean {
  if (i === view.selected || i === view.hovered) return false;
  const wave = scene.agents[i]!.wave;
  return wave >= 0 && board.waveCollapsed[wave] === 1;
}

/** Agents of collapsed waves: one batched path of plain dots. */
function drawCollapsedAgents(
  ctx: DrawContext,
  scene: Scene,
  layout: Layout,
  view: ViewState,
  res: DrawResources,
  board: LabelBoard,
): void {
  let any = false;
  ctx.beginPath();
  for (let i = 1; i < scene.agents.length; i++) {
    if (!collapsedAgent(scene, board, view, i)) continue;
    const x = layout.x[i]!;
    const y = layout.y[i]!;
    const r = Math.min(2.5, layout.r[i]!);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
    any = true;
  }
  if (!any) return;
  ctx.fillStyle = res.palette.rimHi;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** The label above orbit `wave`: its ring summary once collapsed, else `WAVE n` or `SUBAGENTS`. */
function waveLabelFor(
  scene: Scene,
  layout: Layout,
  res: DrawResources,
  board: LabelBoard,
  wave: number,
): Label {
  if (board.waveCollapsed[wave] === 1) return scene.waveSummary[wave]!;
  return layout.ringCount > 1 ? waveLabel(res, wave) : res.subagentsLabel;
}

/** Width of a label, touching `ctx.font` only the first time (setting a font is not free). */
function labelWidth(ctx: DrawContext, label: Label): number {
  return label.width >= 0 ? label.width : measureLabel(ctx, label);
}

/** The labels of the selected (slot 0) and hovered (slot 1) agents' detail rows. */
const detailRow: (Label | null)[] = [null, null, null, null, null, null, null, null];

/**
 * Fill the board's inputs for `placeLabels`: label widths and sizes, the detail rows of the
 * selected and hovered agents (wide canvases only), and the wave labels.
 */
function prepareLabels(
  ctx: DrawContext,
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
  board: LabelBoard,
): void {
  for (let i = 0; i < scene.agents.length; i++) {
    const a = scene.agents[i]!;
    const label = a.isMain || view.selected === i ? a.callsignBold : a.callsign;
    board.agentWidth[i] = labelWidth(ctx, label);
    board.agentSize[i] = label.font.size;
    board.detailWidth[i] = 0;
  }
  for (let slot = 0; slot < 2; slot++) {
    const i = slot === 0 ? view.selected : view.hovered;
    detailRow[slot * 4] = null;
    if (i < 0 || i >= scene.agents.length || !layout.wide) continue;
    if (slot === 1 && i === view.selected) continue;
    board.detailWidth[i] = fillDetailRow(ctx, scene, frame, res, i, slot * 4);
  }
  // Wave labels at every canvas size: a ring that is drawn keeps its label (#128).
  for (let w = 0; w < layout.ringCount; w++) {
    board.waveWidth[w] = labelWidth(ctx, waveLabelFor(scene, layout, res, board, w));
  }
}

/** Put agent `i`'s detail labels in `detailRow` from `at`; return the row's width. */
function fillDetailRow(
  ctx: DrawContext,
  scene: Scene,
  frame: FrameState,
  res: DrawResources,
  i: number,
  at: number,
): number {
  const a = scene.agents[i]!;
  const phase = frame.phase[i]!;
  const end = Math.min(frame.t, a.end);
  const warps = scene.model.warps;
  const elapsed =
    phase === PHASE_QUEUED ? 0 : toRealSeconds(warps, end) - toRealSeconds(warps, a.start);
  const failed = frame.failed[i]!;
  detailRow[at] = a.identity;
  detailRow[at + 1] = res.durations.get(elapsed);
  detailRow[at + 2] = res.calls.get(frame.started[i]!);
  detailRow[at + 3] = failed > 0 ? res.failures.get(failed) : null;
  const sep = labelWidth(ctx, res.separator);
  let width = 0;
  for (let k = 0; k < 4; k++) {
    const label = detailRow[at + k];
    if (label === null || label === undefined) continue;
    width += labelWidth(ctx, label) + (k > 0 ? sep : 0);
  }
  return width;
}

/**
 * The wave labels where the board put them: centred on their ring, over a backing box that hides
 * the ring line under the text. While a label fades to a new angle it is drawn at both, the old
 * one fading out.
 */
function drawWaveLabels(
  ctx: DrawContext,
  scene: Scene,
  layout: Layout,
  res: DrawResources,
  board: LabelBoard,
): void {
  const pal = res.palette;
  for (let w = 0; w < layout.ringCount; w++) {
    if (board.waveShown[w] !== 1) continue;
    const label = waveLabelFor(scene, layout, res, board, w);
    const color = board.waveCollapsed[w] === 1 ? pal.dim : pal.faint;
    const backing = backingAlpha(pal, color);
    if (board.waveGhostShown[w] === 1) {
      drawWaveLabel(
        ctx,
        res,
        label,
        board.waveGhostLeft[w]!,
        board.waveGhostBase[w]!,
        color,
        backing,
        board.waveGhostAlpha[w]!,
      );
    }
    drawWaveLabel(
      ctx,
      res,
      label,
      board.waveLeft[w]!,
      board.waveBase[w]!,
      color,
      backing,
      board.waveAlpha[w]!,
    );
  }
  ctx.globalAlpha = 1;
}

function drawWaveLabel(
  ctx: DrawContext,
  res: DrawResources,
  label: Label,
  left: number,
  base: number,
  color: string,
  backing: number,
  alpha: number,
): void {
  if (!(alpha > 0)) return;
  const width = labelWidth(ctx, label);
  const mid = base - WAVE_BASELINE_DROP;
  ctx.globalAlpha = alpha * backing;
  ctx.fillStyle = res.palette.background;
  ctx.fillRect(
    left - WAVE_PAD_X,
    mid - WAVE_HALF_HEIGHT,
    width + 2 * WAVE_PAD_X,
    2 * WAVE_HALF_HEIGHT,
  );
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = label.font.css;
  ctx.fillText(label.text, left, base);
}

/** Every agent label the board kept, with the selected and hovered detail rows. */
function drawLabels(
  ctx: DrawContext,
  scene: Scene,
  frame: FrameState,
  view: ViewState,
  res: DrawResources,
  board: LabelBoard,
): void {
  const pal = res.palette;
  for (let i = 0; i < scene.agents.length; i++) {
    if (board.agentShown[i] !== 1) continue;
    const a = scene.agents[i]!;
    const selected = view.selected === i;
    const done = frame.phase[i] === PHASE_DONE;
    const label = a.isMain || selected ? a.callsignBold : a.callsign;
    const color = done && !selected ? pal.faint : pal.text;
    drawTagAt(ctx, res, board.agentLeft[i]!, board.agentBase[i]!, label, null, null, null, color);
    if (board.detailWidth[i]! > 0) {
      const at = selected ? 0 : 4;
      const first = detailRow[at];
      if (first === null || first === undefined) continue;
      drawTagAt(
        ctx,
        res,
        board.detailLeft[i]!,
        board.detailBase[i]!,
        first,
        detailRow[at + 1] ?? null,
        detailRow[at + 2] ?? null,
        detailRow[at + 3] ?? null,
        done ? pal.faint : pal.dim,
      );
    }
  }
}

function drawComets(
  ctx: DrawContext,
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  res: DrawResources,
): void {
  const mx = layout.x[0]!;
  const my = layout.y[0]!;
  for (let i = 1; i < scene.agents.length; i++) {
    const d = frame.dispatch[i]!;
    const h = frame.handback[i]!;
    if (d < 0 && h < 0) continue;
    const x = layout.x[i]!;
    const y = layout.y[i]!;
    if (d >= 0) drawComet(ctx, layout, res, mx, my, x, y, d, res.palette.agent, false, null);
    if (h >= 0)
      drawComet(
        ctx,
        layout,
        res,
        x,
        y,
        mx,
        my,
        h,
        res.palette.handback,
        true,
        scene.agents[i]!.handback,
      );
  }
}

function drawComet(
  ctx: DrawContext,
  layout: Layout,
  res: DrawResources,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  p: number,
  color: string,
  handback: boolean,
  label: Label | null,
): void {
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = color;
  for (let k = 10; k >= 0; k--) {
    const q = Math.max(0, p - k * 0.03);
    curvePoint(q, x0, y0, x1, y1);
    ctx.globalAlpha = (1 - k / 11) * 0.85;
    ctx.beginPath();
    ctx.arc(point[0]!, point[1]!, 3.4 * (1 - k / 12), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  curvePoint(p, x0, y0, x1, y1);
  const hx = point[0]!;
  const hy = point[1]!;
  const sprites = res.sprites;
  if (sprites !== null) {
    const glow = handback ? sprites.handback : sprites.dispatch;
    ctx.drawImage(glow.image, hx - glow.radius, hy - glow.radius);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = res.palette.white;
  ctx.beginPath();
  ctx.arc(hx, hy, 1.9, 0, TAU);
  ctx.fill();
  if (label !== null && layout.wide && p > 0.25 && p < 0.8) {
    drawTag(ctx, layout, res, hx, hy - 10, label, color);
  }
}

/** A label centred on `x` with a dark box behind it, kept inside the canvas. */
function drawTag(
  ctx: DrawContext,
  layout: Layout,
  res: DrawResources,
  x: number,
  y: number,
  label: Label,
  color: string,
): void {
  drawTagRow(ctx, layout, res, x, y, label, null, null, null, color);
}

/** Up to four labels in one font drawn as one tag, joined by " · ", centred on `x`. */
function drawTagRow(
  ctx: DrawContext,
  layout: Layout,
  res: DrawResources,
  x: number,
  y: number,
  l0: Label,
  l1: Label | null,
  l2: Label | null,
  l3: Label | null,
  color: string,
): void {
  const w = rowWidth(ctx, res, l0, l1, l2, l3);
  const left = Math.max(4, Math.min(layout.width - w - 4, x - w / 2));
  drawTagAt(ctx, res, left, y, l0, l1, l2, l3, color);
}

function rowWidth(
  ctx: DrawContext,
  res: DrawResources,
  l0: Label,
  l1: Label | null,
  l2: Label | null,
  l3: Label | null,
): number {
  const sepWidth = l1 !== null ? labelWidth(ctx, res.separator) : 0;
  let w = labelWidth(ctx, l0);
  if (l1 !== null) w += labelWidth(ctx, l1) + sepWidth;
  if (l2 !== null) w += labelWidth(ctx, l2) + sepWidth;
  if (l3 !== null) w += labelWidth(ctx, l3) + sepWidth;
  return w;
}

/** Up to four labels drawn as one tag with its text starting at `left`, baseline `y`. */
function drawTagAt(
  ctx: DrawContext,
  res: DrawResources,
  left: number,
  y: number,
  l0: Label,
  l1: Label | null,
  l2: Label | null,
  l3: Label | null,
  color: string,
): void {
  const sep = res.separator;
  const w = rowWidth(ctx, res, l0, l1, l2, l3);
  const sepWidth = l1 !== null ? sep.width : 0;
  const size = l0.font.size;
  ctx.globalAlpha = backingAlpha(res.palette, color);
  ctx.fillStyle = res.palette.background;
  ctx.fillRect(left - 3, y - size + 1, w + 6, size + 3);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.font = l0.font.css;
  ctx.fillText(l0.text, left, y);
  left += l0.width;
  left = drawJoined(ctx, sep, sepWidth, l1, left, y);
  left = drawJoined(ctx, sep, sepWidth, l2, left, y);
  drawJoined(ctx, sep, sepWidth, l3, left, y);
}

function drawJoined(
  ctx: DrawContext,
  sep: Label,
  sepWidth: number,
  label: Label | null,
  left: number,
  y: number,
): number {
  if (label === null) return left;
  if (sepWidth > 0) {
    ctx.fillText(sep.text, left, y);
    left += sepWidth;
  }
  ctx.fillText(label.text, left, y);
  return left + label.width;
}
