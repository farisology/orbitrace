/** Hit testing: which agent is under a point. Pure. */

import type { Layout } from "./layout.js";
import { PHASE_QUEUED } from "./timeline.js";

/** Extra reach around a node's outer radius, in CSS pixels, so small nodes are easy to hit. */
export const HIT_PADDING = 22;

/**
 * Index of the nearest agent whose outer radius plus `padding` contains (`x`, `y`), or -1.
 * Agents that have not started yet (`phase` is queued) cannot be hit; the main agent always can.
 */
export function hitTestAgents(
  layout: Layout,
  phase: Uint8Array,
  x: number,
  y: number,
  padding = HIT_PADDING,
): number {
  let best = -1;
  let bestDistance = Infinity;
  const n = layout.x.length;
  for (let i = 0; i < n; i++) {
    if (i !== 0 && phase[i] === PHASE_QUEUED) continue;
    const dx = layout.x[i]! - x;
    const dy = layout.y[i]! - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < layout.ro[i]! + padding && distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
