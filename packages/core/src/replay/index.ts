/**
 * Replay model builder (ticket #8): `buildReplay` turns a `ParsedSession` into a
 * `ReplayModel` v1, and `replayFeed` derives feed events from a replay. `toRealSeconds`
 * (ticket #71) maps compressed replay time to real seconds.
 */
export { toRealSeconds } from "./real-time.js";
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
