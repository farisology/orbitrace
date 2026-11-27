/**
 * Replay model builder (ticket #8): `buildReplay` turns a `ParsedSession` into a
 * `ReplayModel` v1, and `replayFeed` derives feed events from a replay. `toRealSeconds`
 * (ticket #71) maps compressed replay time to real seconds. `agentPhase` (#108) is the one
 * rule for whether an agent is waiting, running or finished at a time.
 */
export { toRealSeconds } from "./real-time.js";
export { AGENT_PHASES, agentPhase, type AgentPhase, type AgentSpan } from "./phase.js";
export {
  buildReplay,
  DEFAULT_REPLY_PADDING_SECONDS,
  REPLAY_BUILD_DEFAULTS_RESOLVED,
} from "./build.js";
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
