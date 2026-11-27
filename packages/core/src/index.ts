/**
 * Public entry of @orbitrace/core. Browser-safe: nothing reachable from here imports a Node
 * module.
 *
 * Exported here: the contract (raw, parsed, replay and source types, constants, the error codes
 * hosts report, and the function signatures in `api.ts`), the transcript parser
 * (`parseSession`, #6), source resolution and listing (`resolveSources`, `listSessions`,
 * `findSessionByKey`, #7 and #75), the replay model builder and feed (`buildReplay`,
 * `replayFeed`, #8), compressed-to-real time (`toRealSeconds`, #71) and its inverse
 * (`toCompressedSeconds`, #135), the agent phase rule
 * (`agentPhase`, `AGENT_PHASES`, `AgentPhase`, #108), and export and validation
 * (`exportReplay`, `validateReplay`, `describeReplayProblems`, `assertReplay`, #18), the
 * app-to-host messages and their wire layout and checks (`TransportRequest`, `TransportMessage`,
 * `checkTransportRequest`, `parseLiveRequest`, `hostLinkFragment` and the rest, #92, #96), and
 * the display formatters (`formatTokens`, `formatDuration`, `formatDurationShort`, `formatClock`,
 * #86, and `formatAgo`, #129). The replay v1 schema is exported as
 * `@orbitrace/core/schema/replay-v1.schema.json`.
 *
 * Exported from `@orbitrace/core/node` instead: the Claude Code source adapter (#7) and the
 * host-side session-to-replay helper (`createSessionReplayer`, `createNodeSessionReplayer`, #75).
 * The helper's update types (`SessionReplayUpdate`, `SessionReplayListener`) are re-exported here
 * as types only (#84). See docs/architecture.md.
 */

/**
 * `"ready"`: every core ticket of wave B needed for correctness is merged: the parser, sources,
 * builder and export, the Claude Code `watchSession` (#74, landed with #99) and moving the golden
 * replay test out of core (#73). tsc enforces the browser/Node split of the two entries (#72):
 * `packages/core/tsconfig.browser.json` checks this entry and everything it reaches with no Node
 * types, and `packages/core/tsconfig.json` checks the ./node entry and the tests with them.
 * `test/sources/entry-points.test.ts` checks the same split for imports. Checked by
 * `packages/core/test/index.test.ts` and `packages/cli/test/index.test.ts`.
 */
export const CORE_STATUS = "ready" as const;

export * from "./model/raw.js";
export * from "./model/parsed.js";
export * from "./model/replay.js";
export * from "./model/sources.js";
export * from "./model/errors.js";
export * from "./model/transport.js";
export * from "./api.js";
export * from "./parser/index.js";
export * from "./replay/index.js";
export * from "./export/index.js";
export * from "./sources/index.js";
export * from "./host/errors.js";
export * from "./protocol/index.js";
export * from "./format/index.js";
export * from "./ledger/index.js";
// Types only (#84): erased at build time, so no code of the Node-entry replayer reaches this entry.
export type { SessionReplayUpdate, SessionReplayListener } from "./host/session-replayer.js";
