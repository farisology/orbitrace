/**
 * Finding sessions for the commands. Root resolution, listing and building are core's
 * (`resolveSources`, the Claude Code adapter and the session replayer from
 * `@orbitrace/core/node`); this module only turns the command line flags into core's inputs and
 * picks one session for `export`.
 */

import { isAbsolute, resolve } from "node:path";
import {
  SESSION_REPLAY_MESSAGES,
  claudeCodeAdapter,
  createNodeSessionReplayer,
  type SessionReplayer,
  type SessionRootsSource,
} from "@orbitrace/core/node";
import {
  resolveSources,
  type ResolveRootsContext,
  type SourceAdapter,
  type SourceRoot,
} from "@orbitrace/core";
import type { SourceFlags } from "./args.js";
import { CliError } from "./errors.js";

/** What the command needs to know about the process. Passed in, so tests can fake it. */
export interface HostContext {
  /** As in `process.platform`. */
  readonly platform: string;
  /** As in `os.homedir()`. */
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Folder relative paths on the command line are resolved against. */
  readonly cwd: string;
}

/**
 * A problem that does not stop the command. The message shows only what the user typed, or
 * core's path-free reason (`history-unavailable`: the history store is there but cannot be read
 * in this Node, so the sessions only it holds are not listed; `history-not-recorded`: recording
 * is on, but `open` cannot record in this run).
 */
export interface CliWarning {
  readonly code: "config-dir-unavailable" | "history-unavailable" | "history-not-recorded";
  readonly message: string;
}

/** The adapters the command uses. Claude Code is the only runtime. */
export const CLI_ADAPTERS: readonly SourceAdapter[] = [claudeCodeAdapter];

/**
 * A `--config-dir` value as core expects it: absolute. A relative path is resolved against the
 * working folder; a value starting with `~` is left for core, which expands it.
 */
export function toUserRoot(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("~") || isAbsolute(trimmed)) return trimmed;
  return resolve(cwd, trimmed);
}

/** Core's resolution context for these flags. */
export function resolveContext(
  host: HostContext,
  sources: SourceFlags,
  configDirs: readonly string[] = sources.configDirs,
): ResolveRootsContext {
  return {
    platform: host.platform,
    homeDir: host.homeDir,
    env: host.env,
    userRoots: configDirs.map((dir) => toUserRoot(dir, host.cwd)),
    includeExtraRoots: sources.extraRoots,
  };
}

export interface ResolvedRoots {
  readonly roots: readonly SourceRoot[];
  readonly warnings: readonly CliWarning[];
}

/**
 * The roots to search, in core's resolution order, and a warning for each `--config-dir` folder
 * that is missing or cannot be read. Each folder is checked on its own with core's resolver, so
 * the check follows the same rules as the search (for example a path that names the `projects`
 * folder itself).
 */
export async function resolveRoots(
  host: HostContext,
  sources: SourceFlags,
  adapters: readonly SourceAdapter[] = CLI_ADAPTERS,
): Promise<ResolvedRoots> {
  const roots = await resolveSources(resolveContext(host, sources), adapters);
  const warnings: CliWarning[] = [];
  for (const dir of sources.configDirs) {
    const own = await resolveSources(
      resolveContext(host, { configDirs: [dir], extraRoots: false }),
      adapters,
    );
    const found = own.find((root) => root.resolvedBy === "user-setting");
    if (found === undefined || !found.available) {
      warnings.push({
        code: "config-dir-unavailable",
        message: `The folder given with --config-dir was not found or cannot be read: ${dir}`,
      });
    }
  }
  return { roots, warnings };
}

/**
 * Roots resolved again on every listing, for a command that keeps running (`open`): a config
 * folder created after start-up is found by the next listing.
 */
export function rootsOnEveryListing(
  host: HostContext,
  sources: SourceFlags,
  adapters: readonly SourceAdapter[] = CLI_ADAPTERS,
): () => Promise<readonly SourceRoot[]> {
  return () => resolveSources(resolveContext(host, sources), adapters);
}

/** A session replayer over fixed roots, or over roots resolved on every listing. */
export function createReplayer(
  roots: SessionRootsSource,
  adapters: readonly SourceAdapter[] = CLI_ADAPTERS,
): SessionReplayer {
  return createNodeSessionReplayer({ roots, adapters });
}

/** Shortest key prefix accepted in place of a whole key, counted after `<runtime>:`. */
export const MIN_KEY_PREFIX = 4;

/** The part of a key after `<runtime>:`, or the whole key when it has no colon. */
function keyBody(key: string): string {
  const colon = key.indexOf(":");
  return colon === -1 ? key : key.slice(colon + 1);
}

/**
 * The keys that `wanted` names: an exact key, or else every key that starts with it. A prefix
 * may include the `<runtime>:` part or leave it out, and must have at least `MIN_KEY_PREFIX`
 * characters after it.
 */
export function matchSessionKeys(keys: readonly string[], wanted: string): string[] {
  const value = wanted.trim();
  if (keys.includes(value)) return [value];
  if (keyBody(value).length < MIN_KEY_PREFIX) return [];
  const withRuntime = value.includes(":");
  return keys.filter((key) => (withRuntime ? key : keyBody(key)).startsWith(value));
}

export type SessionChoice = { readonly key: string } | { readonly latest: true };

/**
 * The key of the session to use. `--latest` takes the newest session. A key, or a unique start
 * of one, is matched against every session under the roots; the listing also tells the replayer
 * where each session is, so the following `load` does not list again.
 */
export async function chooseSession(
  replayer: SessionReplayer,
  choice: SessionChoice,
): Promise<string> {
  if ("latest" in choice) {
    const [newest] = await replayer.list({ limit: 1 });
    if (newest === undefined) {
      throw new CliError(
        "no-sessions",
        "No sessions were found.",
        "Pass --config-dir <path> to search another Claude Code config folder, or --extra-roots.",
      );
    }
    return newest.key;
  }
  const sessions = await replayer.list();
  const matches = matchSessionKeys(
    sessions.map((session) => session.key),
    choice.key,
  );
  if (matches.length === 1) return matches[0] as string;
  if (matches.length === 0) {
    throw new CliError(
      "not-found",
      SESSION_REPLAY_MESSAGES.notFound,
      "Run 'orbitrace list' to see the session keys.",
    );
  }
  throw new CliError(
    "ambiguous",
    `${matches.length} sessions have a key that starts with that value.`,
    "Give more characters of the key.",
  );
}
