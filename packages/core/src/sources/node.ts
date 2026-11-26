/// <reference types="node" />
/**
 * `@orbitrace/core/node`: the parts of source resolution that read files (ticket #7).
 *
 * Kept off the main entry so the browser bundle of core never pulls in a Node module. Hosts
 * (the CLI, the editor extension) import the adapter from here and `resolveSources` /
 * `listSessions` from `@orbitrace/core`.
 */

import { homedir } from "node:os";
import type { ResolveRootsContext } from "../model/sources.js";

export * from "./claude-code/adapter.js";
export * from "./claude-code/fs.js";
export * from "./claude-code/paths.js";
export * from "./claude-code/registry.js";

/** Settings a host passes in; the OS, home folder and environment come from the process. */
export type NodeResolveOptions = Omit<ResolveRootsContext, "platform" | "homeDir" | "env">;

/**
 * A `ResolveRootsContext` for this process: `process.platform`, `os.homedir()` and
 * `process.env`, plus the host's settings.
 */
export function nodeResolveContext(options: NodeResolveOptions = {}): ResolveRootsContext {
  return { platform: process.platform, homeDir: homedir(), env: process.env, ...options };
}
