/**
 * Source adapters: where sessions come from (ticket #7).
 *
 * An adapter knows one agent runtime's files. Claude Code is the only runtime at launch;
 * another runtime is added by writing an adapter that produces the same `SessionInput`
 * for its parser, and adding its id to `RuntimeId`. Nothing above this layer touches the
 * file system.
 *
 * Adapters run on the host side only. A file the user drops onto the app does not go
 * through an adapter or a source root: the app reads the dropped file's text and parses it
 * itself with core (see `docs/architecture.md`).
 *
 * Everything in this file is local data for the user's own machine: roots and locators are
 * file paths, `projectLabel` comes from the working directory, `sessionId` is the runtime's
 * id. None of it may be written into a replay model.
 */

import type { SessionInput } from "./raw.js";

/** Agent runtimes with an adapter. Widened when an adapter is added. */
export type RuntimeId = "claude-code";

/**
 * How a source root was found. Listed in resolution order: an explicit user setting first,
 * then the runtime's environment variable (`CLAUDE_CONFIG_DIR` for Claude Code), the
 * per-OS default, extra roots the user opted in to, and paths reported by hooks. Dropped
 * files are not a source root; the app handles them without the host.
 */
export const SOURCE_RESOLUTIONS = [
  "user-setting",
  "environment",
  "os-default",
  "extra-root",
  "hook",
] as const;

export type SourceResolution = (typeof SOURCE_RESOLUTIONS)[number];

/** One folder that holds sessions for a runtime. */
export interface SourceRoot {
  readonly runtime: RuntimeId;
  /**
   * Absolute path of the config root (for Claude Code, the folder that holds `projects/`).
   * Local only.
   */
  readonly root: string;
  readonly resolvedBy: SourceResolution;
  /** Whether the root existed and was readable when resolved. */
  readonly available: boolean;
}

/** Live status of a session, from the optional live registry. */
export const LIVE_STATUSES = ["busy", "idle", "ended", "unknown"] as const;

/**
 * `busy` and `idle` come from a live registry entry whose process is alive. `ended` means
 * an entry was found but its process is gone, or no entry was found and the runtime writes
 * one. `unknown` means the runtime has no live registry or it could not be read.
 */
export type LiveStatus = (typeof LIVE_STATUSES)[number];

/** A session found under a source root. Local only. */
export interface SessionRef {
  /** Stable key for this session across calls, for example in a host transport. Opaque. */
  readonly key: string;
  readonly runtime: RuntimeId;
  /** The root the session was found under. Carries the path and how it was resolved. */
  readonly source: SourceRoot;
  /**
   * Readable project name for lists, for example the last segment of the working
   * directory. Not the encoded project folder name. Local only.
   */
  readonly projectLabel: string;
  /** Runtime session id. Local only. */
  readonly sessionId: string;
  /** Last activity (newest transcript write or registry update), Unix epoch milliseconds. */
  readonly lastActivity: number;
  readonly live: LiveStatus;
  /** Number of subagent transcripts found beside the session, when the adapter counted them. */
  readonly subagentCount: number | null;
  /** Adapter-specific location (for Claude Code, the transcript path). Only the adapter reads it. */
  readonly locator: string;
}

/**
 * The part of a `SessionRef` that may cross a host transport to the app's session list.
 * No paths and no locator. It is still local data, shown only to the user who owns it.
 */
export type SessionSummary = Pick<
  SessionRef,
  "key" | "runtime" | "projectLabel" | "sessionId" | "lastActivity" | "live" | "subagentCount"
>;

/** Inputs for root resolution. Passed in, never read from globals, so it can be tested. */
export interface ResolveRootsContext {
  /** OS, as in Node's `process.platform`. */
  readonly platform: string;
  /** User's home folder. */
  readonly homeDir: string;
  /** Environment variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Roots set explicitly by the user (settings, CLI flag). Highest priority. */
  readonly userRoots?: readonly string[];
  /** Include extra roots that need opt-in (for example the desktop app's own folders). */
  readonly includeExtraRoots?: boolean;
  /** Transcript paths reported by hooks. */
  readonly hookTranscriptPaths?: readonly string[];
}

export interface ListSessionsOptions {
  /** Only sessions with activity at or after this time, Unix epoch milliseconds. */
  readonly since?: number;
  /** Maximum number of sessions, newest first. */
  readonly limit?: number;
}

/** Called when a watched session changes. The listener reopens the session to read it. */
export type SessionChangeListener = (ref: SessionRef) => void;

/** Stops a watch or a subscription. Safe to call more than once. */
export type Unsubscribe = () => void;

/**
 * One runtime's file access. Implementations live in core (ticket #7 for Claude Code)
 * and use Node file APIs; the interface itself has no Node dependency.
 */
export interface SourceAdapter {
  readonly runtime: RuntimeId;
  /** Name for settings and messages, for example `Claude Code`. */
  readonly displayName: string;
  /** Candidate roots in resolution order, duplicates removed. */
  resolveRoots(context: ResolveRootsContext): Promise<readonly SourceRoot[]>;
  /** Sessions under one root, newest first. */
  listSessions(root: SourceRoot, options?: ListSessionsOptions): Promise<readonly SessionRef[]>;
  /** Open the main transcript, subagent transcripts and meta files of one session. */
  openSession(ref: SessionRef): Promise<SessionInput>;
  /** Watch one session for new lines. Optional: an adapter without live support omits it. */
  watchSession?(ref: SessionRef, listener: SessionChangeListener): Unsubscribe;
}
