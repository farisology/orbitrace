/**
 * Public entry of @orbitrace/core. Browser-safe: nothing reachable from here imports a Node
 * module.
 *
 * Exported here: the contract (raw, parsed, replay and source types, constants, the error codes
 * hosts report, and the function signatures in `api.ts`), the transcript parser
 * (`parseSession`, #6), source resolution and listing (`resolveSources`, `listSessions`,
 * `findSessionByKey`, #7 and #75), the replay model builder and feed (`buildReplay`,
 * `replayFeed`, #8), compressed-to-real time (`toRealSeconds`, #71), and export and validation
 * (`exportReplay`, `validateReplay`, `describeReplayProblems`, `assertReplay`, #18). The replay
 * v1 schema is exported as `@orbitrace/core/schema/replay-v1.schema.json`.
 *
 * Exported from `@orbitrace/core/node` instead: the Claude Code source adapter (#7) and the
 * host-side session-to-replay helper (`createSessionReplayer`, `createNodeSessionReplayer`, #75).
 * The helper's update types (`SessionReplayUpdate`, `SessionReplayListener`) are re-exported here
 * as types only (#84). See docs/architecture.md.
 */

/**
 * Stays `"scaffold"` until every core ticket of wave B is merged: besides the parser, sources,
 * builder and export (all merged), that is the Claude Code `watchSession` (#74), the core
 * tsconfig split for the two entries (#72) and moving the golden replay test out of core (#73).
 * The ticket that merges the last of them changes it to `"ready"`, together with
 * `packages/core/test/index.test.ts` and `packages/cli/test/index.test.ts`, which check it.
 */
export const CORE_STATUS = "scaffold" as const;

export * from "./model/raw.js";
export * from "./model/parsed.js";
export * from "./model/replay.js";
export * from "./model/sources.js";
export * from "./model/errors.js";
export * from "./api.js";
export * from "./parser/index.js";
export * from "./replay/index.js";
export * from "./export/index.js";
export * from "./sources/index.js";
export * from "./host/errors.js";
// Types only (#84): erased at build time, so no code of the Node-entry replayer reaches this entry.
export type { SessionReplayUpdate, SessionReplayListener } from "./host/session-replayer.js";
