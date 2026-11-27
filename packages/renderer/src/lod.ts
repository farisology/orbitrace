/**
 * Level of detail (#14). The level is chosen once per model from its agent count, so a
 * session always looks the same at a given size and the drawing degrades in fixed steps:
 *
 * - `LOD_FULL`, up to `LOD_FULL_MAX_AGENTS` agents (main agent included): everything is drawn.
 *   The 60 fps budget is set for this level.
 * - `LOD_REDUCED`, up to `LOD_REDUCED_MAX_AGENTS`: finished agents drop their moons (their
 *   call count stays in the selected or hovered agent's detail row), fresh-moon glows are off,
 *   and at most `LABEL_BUDGET[LOD_REDUCED]` agent labels are shown besides the selected and
 *   hovered ones.
 * - `LOD_MINIMAL`, above that: as reduced, and running agents drop their moons too, spoke
 *   name tags are off, the label budget is `LABEL_BUDGET[LOD_MINIMAL]`, and every wave whose
 *   agents have all finished collapses into a ring summary: its orbit is drawn solid with a
 *   `WAVE n · k done` label, its agents become plain dots with no tether, token arc or label.
 *   The selected and hovered agents are always drawn in full.
 *
 * Labels never overlap at any level (label-layout.ts); the budget only bounds their number.
 * Pure: no canvas, no allocation.
 */

import type { Scene } from "./scene.js";
import { PHASE_DONE, type FrameState } from "./timeline.js";

export const LOD_FULL = 0;
export const LOD_REDUCED = 1;
export const LOD_MINIMAL = 2;

/** Largest agent count (main agent included) drawn at full detail. */
export const LOD_FULL_MAX_AGENTS = 100;
/** Largest agent count drawn at reduced detail; above it the level is minimal. */
export const LOD_REDUCED_MAX_AGENTS = 250;

/**
 * Most labels of agents that are neither selected nor hovered, per level. Full detail has no
 * cap besides collisions.
 */
export const LABEL_BUDGET: readonly number[] = Object.freeze([Infinity, 24, 12]);

/** The level of detail for a model with `agentCount` agents. */
export function lodFor(agentCount: number): number {
  if (agentCount <= LOD_FULL_MAX_AGENTS) return LOD_FULL;
  return agentCount <= LOD_REDUCED_MAX_AGENTS ? LOD_REDUCED : LOD_MINIMAL;
}

/** Whether labels look for spots that cover no node as well as no label (full detail only). */
export function labelsAvoidNodes(lod: number): boolean {
  return lod === LOD_FULL;
}

/** Whether an agent in `phase` draws its moons at `lod`. Selected or hovered agents always do. */
export function drawsMoons(lod: number, phase: number, focused: boolean): boolean {
  if (focused || lod === LOD_FULL) return true;
  if (lod === LOD_REDUCED) return phase !== PHASE_DONE;
  return false;
}

/** Whether a fresh moon gets its glow sprite at `lod`. */
export function drawsMoonGlow(lod: number): boolean {
  return lod === LOD_FULL;
}

/** Whether running calls show their tool name and seconds beside the spoke at `lod`. */
export function drawsSpokeTags(lod: number): boolean {
  return lod !== LOD_MINIMAL;
}

/**
 * Mark the waves drawn as ring summaries this frame: at `LOD_MINIMAL`, every wave whose agents
 * have all finished. `open` is scratch (agents per wave not yet finished). Returns how many
 * waves collapsed.
 */
export function markCollapsedWaves(
  scene: Scene,
  frame: FrameState,
  lod: number,
  collapsed: Uint8Array,
  open: Uint32Array,
): number {
  const waves = scene.waveCount;
  for (let w = 0; w < waves; w++) {
    collapsed[w] = 0;
    open[w] = 0;
  }
  if (lod !== LOD_MINIMAL) return 0;
  for (let i = 1; i < scene.agents.length; i++) {
    const wave = scene.agents[i]!.wave;
    if (wave >= 0 && frame.phase[i] !== PHASE_DONE) open[wave]!++;
  }
  let count = 0;
  for (let w = 0; w < waves; w++) {
    // Queued agents count as open, so a wave with none open has finished, not just not started.
    if (open[w] === 0 && scene.waveSizes[w]! > 0) {
      collapsed[w] = 1;
      count++;
    }
  }
  return count;
}
