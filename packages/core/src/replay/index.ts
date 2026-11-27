/**
 * Replay model builder (ticket #8): `buildReplay` turns a `ParsedSession` into a
 * `ReplayModel` v1, and `replayFeed` derives feed events from a replay. `toRealSeconds`
 * (ticket #71) maps compressed replay time to real seconds, and `toCompressedSeconds` (#135) maps
 * it back. `agentPhase` (#108) is the one rule for whether an agent is waiting, running or
 * finished at a time. `describeReplayModelProblems` and `validateReplayModel` (#190, #191) check
 * an in-memory model that may carry reply details; `withoutReplyDetails` takes them out.
 */
export { toCompressedSeconds, toRealSeconds } from "./real-time.js";
export { AGENT_PHASES, agentPhase, type AgentPhase, type AgentSpan } from "./phase.js";
export {
  buildReplay,
  DEFAULT_REPLY_PADDING_SECONDS,
  REPLAY_BUILD_DEFAULTS_RESOLVED,
  replyDetailsOf,
} from "./build.js";
export {
  describeReplayModelProblems,
  REPLY_DETAIL_KEYS,
  validateReplayModel,
  withoutReplyDetails,
} from "./details.js";
export {
  replayFeed,
  REPLAY_FEED_DEFAULTS,
  type ReplayDispatchEvent,
  type ReplayFailedCall,
  type ReplayFailuresEvent,
  type ReplayFeedEvent,
  type ReplayFeedOptions,
  type ReplayHandbackEvent,
  type ReplayIdleEvent,
} from "./feed.js";
