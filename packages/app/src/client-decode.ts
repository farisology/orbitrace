/**
 * Checks the app runs on what a host sends back, shared by the webview and HTTP transports.
 * A host is trusted to send the right shapes, but a reply that is not one is turned into a
 * `TransportError` the app can show, instead of a crash further down.
 *
 * Session summaries are copied field by field, so nothing beyond `SessionSummary` (a path or a
 * locator sent by mistake) is kept app-side.
 */

import {
  LIVE_STATUSES,
  RUNTIME_IDS,
  describeReplayProblems,
  validateReplay,
  type LiveStatus,
  type ReplayModel,
  type RuntimeId,
  type SessionSummary,
} from "@orbitrace/core";
import { isTransportError, transportError } from "./protocol";
import type { LiveUpdate, TransportError } from "./transport";

export const CLIENT_MESSAGES = {
  badSessions: "The host sent a session list the app could not read.",
  badReplay: "The host sent a replay that did not pass the replay format check.",
  failed: "The request to the host failed.",
} as const;

function isLiveStatus(value: unknown): value is LiveStatus {
  return typeof value === "string" && (LIVE_STATUSES as readonly string[]).includes(value);
}

/** A runtime core has an adapter for (`RUNTIME_IDS`, #94), so a new adapter needs no change here. */
function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && (RUNTIME_IDS as readonly string[]).includes(value);
}

/** One session summary, copied field by field, or `null` when a field is missing or wrong. */
export function decodeSessionSummary(value: unknown): SessionSummary | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { key, runtime, projectLabel, sessionId, lastActivity, live, subagentCount } = record;
  if (typeof key !== "string" || key === "") return null;
  if (!isRuntimeId(runtime)) return null;
  if (typeof projectLabel !== "string" || typeof sessionId !== "string") return null;
  if (typeof lastActivity !== "number" || !Number.isFinite(lastActivity)) return null;
  if (!isLiveStatus(live)) return null;
  if (subagentCount !== null && (typeof subagentCount !== "number" || subagentCount < 0)) {
    return null;
  }
  return { key, runtime, projectLabel, sessionId, lastActivity, live, subagentCount };
}

/**
 * The result of `listSessions`. Throws an `invalid` `TransportError` when it is not a list; drops
 * entries that are not session summaries.
 */
export function decodeSessions(value: unknown): readonly SessionSummary[] {
  if (!Array.isArray(value)) throw transportError("invalid", CLIENT_MESSAGES.badSessions);
  const sessions: SessionSummary[] = [];
  for (const entry of value) {
    const summary = decodeSessionSummary(entry);
    if (summary !== null) sessions.push(summary);
  }
  return sessions;
}

function invalidReplay(value: unknown): TransportError {
  const problems = describeReplayProblems(value);
  const detail = problems.length > 0 ? ` ${problems.slice(0, 3).join("; ")}` : "";
  return transportError("invalid", `${CLIENT_MESSAGES.badReplay}${detail}`);
}

/** The result of `loadReplay`. Throws an `invalid` `TransportError` when it is not a valid replay. */
export function decodeReplay(value: unknown): ReplayModel {
  if (validateReplay(value)) return value;
  throw invalidReplay(value);
}

/** A live update as the app may show it: a `replay` whose model is not valid becomes an `error`. */
export function decodeLiveUpdate(update: LiveUpdate): LiveUpdate {
  if (update.type !== "replay") return update;
  if (validateReplay(update.replay)) return update;
  return { type: "error", error: invalidReplay(update.replay) };
}

/** Any rejection as a `TransportError`, with `fallback` as the message for unknown values. */
export function asTransportError(error: unknown, fallback: string = CLIENT_MESSAGES.failed) {
  return isTransportError(error)
    ? transportError(error.code, error.message)
    : transportError("internal", fallback);
}
