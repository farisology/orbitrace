/**
 * Layout: where each agent sits for a canvas size. Main agent in the centre, one orbit per
 * wave, later waves further out, odd waves offset by half a step so tethers pass between
 * nodes. Pure; computed when the model or the size changes, never per frame.
 */

import type { Scene } from "./scene.js";

/** Canvases wider than this get full labels and larger nodes. */
export const WIDE_BREAKPOINT = 640;
/** Fraction of `base` used by the innermost orbit when there is more than one wave. */
export const INNER_ORBIT = 0.56;
/** Fraction of `base` used by the single orbit when there is one wave. */
export const SINGLE_ORBIT = 0.85;
/** Fixed rotation so no node sits exactly on the vertical axis. */
export const ORBIT_ROTATION = 0.18;
/** Outer radius of a node relative to its body radius (room for the token arc). */
export const OUTER_RATIO = 1.22;

export interface Layout {
  width: number;
  height: number;
  cx: number;
  cy: number;
  /** Radius of the outermost orbit. */
  base: number;
  wide: boolean;
  ringCount: number;
  ringRadius: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Angle of the agent from the centre (outward direction). */
  angle: Float64Array;
  /** Body radius. */
  r: Float64Array;
  /** Outer radius: body plus token arc. */
  ro: Float64Array;
}

export function createLayout(agentCount: number, waveCount: number): Layout {
  return {
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    base: 0,
    wide: false,
    ringCount: waveCount,
    ringRadius: new Float64Array(waveCount),
    x: new Float64Array(agentCount),
    y: new Float64Array(agentCount),
    angle: new Float64Array(agentCount),
    r: new Float64Array(agentCount),
    ro: new Float64Array(agentCount),
  };
}

/** Radius of orbit `wave` out of `waveCount`, for an outermost radius `base`. */
export function orbitRadius(wave: number, waveCount: number, base: number): number {
  if (waveCount <= 1) return base * SINGLE_ORBIT;
  return base * (INNER_ORBIT + ((1 - INNER_ORBIT) * wave) / (waveCount - 1));
}

/** Angle of slot `slot` of `size` on orbit `wave`. Odd waves shift by half a step. */
export function orbitAngle(slot: number, size: number, wave: number): number {
  const step = (Math.PI * 2) / Math.max(1, size);
  return -Math.PI / 2 + slot * step + (wave % 2 === 1 ? step / 2 : 0) + ORBIT_ROTATION;
}

/** Fill `out` (or a new layout) with positions for a `width` by `height` canvas in CSS pixels. */
export function computeLayout(scene: Scene, width: number, height: number, out?: Layout): Layout {
  const n = scene.agents.length;
  const layout =
    out !== undefined && out.x.length === n && out.ringRadius.length === scene.waveCount
      ? out
      : createLayout(n, scene.waveCount);
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  layout.width = w;
  layout.height = h;
  layout.cx = w / 2;
  layout.cy = h / 2;
  layout.base = Math.max(0, Math.min(w * 0.42, h * 0.365));
  layout.wide = w > WIDE_BREAKPOINT;
  layout.ringCount = scene.waveCount;
  for (let i = 0; i < scene.waveCount; i++) {
    layout.ringRadius[i] = orbitRadius(i, scene.waveCount, layout.base);
  }

  // Keep nodes on neighbouring orbits from overlapping when there are many waves.
  const ringGap =
    scene.waveCount > 1 ? (layout.base * (1 - INNER_ORBIT)) / (scene.waveCount - 1) : Infinity;
  for (const agent of scene.agents) {
    const i = agent.index;
    if (agent.isMain) {
      layout.x[i] = layout.cx;
      layout.y[i] = layout.cy;
      layout.angle[i] = Math.PI / 2;
      layout.r[i] = layout.wide ? 22 : 16;
    } else {
      const size = scene.waveSizes[agent.wave] ?? 1;
      const a = orbitAngle(agent.waveSlot, size, agent.wave);
      const radius = layout.ringRadius[agent.wave] ?? layout.base;
      layout.x[i] = layout.cx + Math.cos(a) * radius;
      layout.y[i] = layout.cy + Math.sin(a) * radius;
      layout.angle[i] = a;
      const preferred = layout.wide ? (scene.waveCount > 1 && agent.wave === 0 ? 12 : 14) : 9;
      const slotGap = (Math.PI * 2 * radius) / Math.max(1, size);
      layout.r[i] = Math.max(4, Math.min(preferred, ringGap * 0.4, slotGap * 0.3));
    }
    layout.ro[i] = layout.r[i]! * OUTER_RATIO;
  }
  return layout;
}
