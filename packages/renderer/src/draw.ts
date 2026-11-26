/**
 * Drawing: paints one frame from a scene, a layout and a frame state. Takes any
 * `DrawContext`, so tests pass a recording mock. The hot path allocates nothing: every
 * array is preallocated, every label is cached, every gradient and sprite is reused.
 */

import type { DrawContext } from "./context.js";
import { realSeconds } from "./format.js";
import { WHITE_CORE } from "./generated/design.js";
import { measureLabel, type Label } from "./labels.js";
import type { Layout } from "./layout.js";
import { ensureGradients, waveLabel, STAR_STRIDE, type DrawResources } from "./resources.js";
import type { AgentScene, Scene } from "./scene.js";
import { innerScale, traceShape } from "./shapes.js";
import { BUCKET_COUNT, BUCKET_FAILURE } from "./theme.js";
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

  ensureGradients(ctx, res, layout.width, layout.height, layout.cx, layout.cy, layout.base);
  drawBackdrop(ctx, layout, frame, view, res);
  drawTethers(ctx, scene, layout, frame, view, res);
  // Subagents first, the main agent last so it sits on top.
  for (let i = 1; i < scene.agents.length; i++)
    drawAgent(ctx, scene, scene.agents[i]!, layout, frame, view, res);
  drawAgent(ctx, scene, scene.agents[0]!, layout, frame, view, res);
  drawComets(ctx, scene, layout, frame, res);

  const g = res.gradients;
  if (g.vignette !== null) {
    ctx.fillStyle = g.vignette;
    ctx.fillRect(0, 0, layout.width, layout.height);
  }
  if (frame.warpIndex >= 0 && frame.warpFactor > 0.02) {
    const label = (layout.wide ? scene.warpLabel : scene.warpLabelNarrow)[frame.warpIndex];
    if (label !== undefined) {
      const w = measureLabel(ctx, label);
      ctx.globalAlpha = frame.warpFactor;
      ctx.fillStyle = pal.text;
      ctx.fillText(label.text, layout.cx - w / 2, layout.cy - layout.base * 0.36);
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
  for (let i = 0; i < layout.ringCount; i++) {
    const R = layout.ringRadius[i]!;
    ctx.moveTo(cx + R, cy);
    ctx.arc(cx, cy, R, 0, TAU);
  }
  ctx.stroke();
  ctx.setLineDash(NO_DASH);
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

  if (layout.wide && layout.ringCount > 0) {
    ctx.fillStyle = pal.faint;
    for (let i = 0; i < layout.ringCount; i++) {
      // Left of the vertical axis: the first node of every orbit sits just right of it.
      const label = layout.ringCount > 1 ? waveLabel(res, i) : res.subagentsLabel;
      const w = measureLabel(ctx, label);
      ctx.fillText(label.text, cx - 6 - w, cy - layout.ringRadius[i]! - 5);
    }
  }

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

  // Moons: calls whose spoke is over, batched into one path per colour.
  const started = frame.started[i]!;
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
      if (!reduced && sprites !== null) {
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
  let labelled = 0;
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

  // Labels. Finished agents lose their label unless selected or hovered.
  const up = !a.isMain && y < layout.cy;
  const dy = up ? -1 : 1;
  const ly = y + dy * (ro + (a.isMain ? 35 : 33)) + (up ? 0 : 9);
  if (!done || a.isMain || selected || hovered || frame.activeSubagents === 0) {
    const label = a.isMain || selected ? a.callsignBold : a.callsign;
    drawTag(ctx, layout, res, x, ly, label, done && !selected ? pal.faint : pal.text);
  }
  if ((selected || hovered) && layout.wide) {
    const end = Math.min(t, a.end);
    const warps = scene.model.warps;
    const elapsed =
      phase === PHASE_QUEUED ? 0 : realSeconds(warps, end) - realSeconds(warps, a.start);
    const failed = frame.failed[i]!;
    drawTagRow(
      ctx,
      layout,
      res,
      x,
      ly + dy * 14,
      a.identity,
      res.durations.get(elapsed),
      res.calls.get(frame.started[i]!),
      failed > 0 ? res.failures.get(failed) : null,
      done ? pal.faint : pal.dim,
    );
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
  const sep = res.separator;
  const sepWidth = l1 !== null ? measureLabel(ctx, sep) : 0;
  let w = measureLabel(ctx, l0);
  if (l1 !== null) w += measureLabel(ctx, l1) + sepWidth;
  if (l2 !== null) w += measureLabel(ctx, l2) + sepWidth;
  if (l3 !== null) w += measureLabel(ctx, l3) + sepWidth;
  const size = l0.font.size;
  let left = x - w / 2;
  left = Math.max(4, Math.min(layout.width - w - 4, left));
  ctx.globalAlpha = 0.72;
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
