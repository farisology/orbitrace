/// <reference types="node" />
/**
 * `@orbitrace/core/node`: the parts of core that read files or the process, for hosts only.
 *
 * - The Claude Code adapter and its file access (ticket #7), and the session file watcher behind
 *   its `watchSession` (ticket #74).
 * - The session-to-replay helper (ticket #75): `createSessionReplayer` over any adapters and
 *   roots, and `createNodeSessionReplayer`, which fills in the Claude Code adapter and this
 *   process's roots.
 *
 * Kept off the main entry so the browser bundle of core never pulls in a Node module. Hosts
 * (the CLI, the editor extension) import these from here and everything else from
 * `@orbitrace/core`.
 */

import { homedir } from "node:os";
import {
  createSessionReplayer,
  type SessionReplayer,
  type SessionReplayerOptions,
} from "../host/session-replayer.js";
import type { ResolveRootsContext } from "../model/sources.js";
import { claudeCodeAdapter } from "./claude-code/adapter.js";
import { resolveSources } from "./index.js";

export * from "./claude-code/adapter.js";
export * from "./claude-code/fs.js";
export * from "./claude-code/paths.js";
export * from "./claude-code/registry.js";
export * from "./claude-code/watch.js";
export * from "../host/session-replayer.js";
// Also on the main entry; repeated here so a host gets the replayer and its errors in one import.
export * from "../host/errors.js";
// The history store and its indexer (#25): opt-in, nothing runs on import.
export * from "../history/index.js";

/** Settings a host passes in; the OS, home folder and environment come from the process. */
export type NodeResolveOptions = Omit<ResolveRootsContext, "platform" | "homeDir" | "env">;

/**
 * A `ResolveRootsContext` for this process: `process.platform`, `os.homedir()` and
 * `process.env`, plus the host's settings.
 */
export function nodeResolveContext(options: NodeResolveOptions = {}): ResolveRootsContext {
  return { platform: process.platform, homeDir: homedir(), env: process.env, ...options };
}

/** Options of `createNodeSessionReplayer`. Every field has a default. */
export interface NodeSessionReplayerOptions extends Partial<SessionReplayerOptions> {
  /**
   * Host settings for root resolution (user roots, extra roots, hook paths). Used only when
   * `roots` is not given.
   */
  readonly resolve?: NodeResolveOptions;
}

/**
 * A `SessionReplayer` for this process. Defaults: the Claude Code adapter on Node's file
 * system, and roots resolved with `resolveSources(nodeResolveContext(resolve), adapters)` again
 * on every listing, so a config folder created after start-up is found.
 */
export function createNodeSessionReplayer(
  options: NodeSessionReplayerOptions = {},
): SessionReplayer {
  const adapters = options.adapters ?? [claudeCodeAdapter];
  const resolve = options.resolve;
  const roots =
    options.roots ?? (() => resolveSources(nodeResolveContext(resolve ?? {}), adapters));
  return createSessionReplayer({
    adapters,
    roots,
    ...(options.build === undefined ? {} : { build: options.build }),
  });
}
