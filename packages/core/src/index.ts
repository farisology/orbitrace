/**
 * Public entry of @orbitrace/core.
 *
 * The contract (types, constants and the replay v1 schema) is in place. The parser, source
 * resolution, replay model builder and export are not built yet; see docs/architecture.md.
 */
export const CORE_STATUS = "scaffold" as const;

export * from "./model/raw.js";
export * from "./model/parsed.js";
export * from "./model/replay.js";
export * from "./model/sources.js";
export * from "./api.js";
export * from "./parser/index.js";
