/**
 * Public entry of @orbitrace/renderer. The API types are in place; the Canvas 2D engine is
 * not built yet. This package has no framework dependency.
 */
export const RENDERER_STATUS = "scaffold" as const;

export type * from "./api.js";
