/**
 * Public entry of @orbitrace/renderer: a framework-free Canvas 2D engine that draws one
 * replay model. The host owns the clock; see `OrreryHandle` in api.ts.
 */
export type * from "./api.js";
// `OrreryEnvironment` comes with api.ts above (#70).
export type { DrawContext, SpriteSurface } from "./context.js";
export { browserEnvironment, createOrrery, createOrreryWithEnvironment } from "./orrery.js";
export { DEFAULT_THEME } from "./theme.js";
