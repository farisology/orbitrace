/**
 * Model identity: the outline is the model family, the inner fill is the effort level.
 * Geometry comes from design/model-shapes.json through the generated module.
 */

import { KNOWN_MODEL_FAMILIES, type EffortLevel, type KnownModelFamily } from "@orbitrace/core";
import type { PathContext } from "./context.js";
import {
  EFFORT_FILL,
  FAMILY_SHAPES,
  INNER_SCALE,
  UNKNOWN_EFFORT_FILL,
} from "./generated/design.js";

export interface NodeShape {
  readonly family: KnownModelFamily;
  readonly label: string;
  /** Flattened x, y pairs for radius 1, or `null` for a circle of radius 1. */
  readonly points: Float64Array | null;
  readonly coreX: number;
  readonly coreY: number;
}

function toShape(family: KnownModelFamily): NodeShape {
  const def = FAMILY_SHAPES[family];
  let points: Float64Array | null = null;
  if (def.points !== null) {
    points = new Float64Array(def.points.length * 2);
    def.points.forEach((p, i) => {
      points![i * 2] = p[0];
      points![i * 2 + 1] = p[1];
    });
  }
  return Object.freeze({
    family,
    label: def.label,
    points,
    coreX: def.core[0],
    coreY: def.core[1],
  });
}

const SHAPES: ReadonlyMap<string, NodeShape> = new Map(
  KNOWN_MODEL_FAMILIES.map((family) => [family, toShape(family)] as const),
);
const UNKNOWN_SHAPE = SHAPES.get("unknown")!;

/** The shape for a family. Any family outside `KNOWN_MODEL_FAMILIES` draws as `unknown`. */
export function shapeForFamily(family: string): NodeShape {
  return SHAPES.get(family) ?? UNKNOWN_SHAPE;
}

/** Inner fill fraction for an effort level; `null` (not recorded) gives the in-between value. */
export function effortFill(effort: EffortLevel | null): number {
  if (effort === null) return UNKNOWN_EFFORT_FILL;
  return EFFORT_FILL[effort] ?? UNKNOWN_EFFORT_FILL;
}

/** Scale of the inner shape relative to the outer one, for a fill fraction above 0. */
export function innerScale(fill: number): number {
  return INNER_SCALE.scaleBase + INNER_SCALE.scaleSpan * fill;
}

/** Start a new path with the node outline of radius `r` centred on (`x`, `y`). */
export function traceShape(
  ctx: PathContext,
  shape: NodeShape,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  const points = shape.points;
  if (points === null) {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  ctx.moveTo(x + points[0]! * r, y + points[1]! * r);
  for (let i = 2; i < points.length; i += 2) {
    ctx.lineTo(x + points[i]! * r, y + points[i + 1]! * r);
  }
  ctx.closePath();
}
