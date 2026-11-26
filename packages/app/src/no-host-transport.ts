/**
 * The `HostTransport` for running with no host: no editor extension and no CLI server. It
 * serves a fixed list of bundled replays, such as the demo. Every replay is checked with
 * `validateReplay` before it is handed to the app.
 *
 * Bundled replays never change, so `subscribe` sends the current state, then `ended`.
 */

import {
  describeReplayProblems,
  validateReplay,
  type ListSessionsOptions,
  type ReplayModel,
  type SessionSummary,
} from "@orbitrace/core";
import { isTransportError, transportError } from "./protocol";
import type { HostTransport, LiveUpdateListener } from "./transport";

// Defined once in `protocol.ts`; re-exported here, where the app first used them.
export { isTransportError, transportError };

/** One replay the no-host transport can serve. */
export interface BundledSession {
  readonly summary: SessionSummary;
  /** Loads the replay data. Called at most once; the result is checked before use. */
  readonly load: () => Promise<unknown>;
}

export const NO_HOST_MESSAGES = {
  notFound: "No bundled session with that key.",
  invalid: "The bundled replay did not pass the replay format check.",
  unreadable: "The bundled replay could not be loaded.",
  unsupported: "Opening in a browser needs the editor extension.",
} as const;

/** Create the no-host transport over the given bundled sessions, listed in the order given. */
export function createNoHostTransport(sessions: readonly BundledSession[]): HostTransport {
  const cache = new Map<string, Promise<ReplayModel>>();

  const loadReplay = (key: string): Promise<ReplayModel> => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const session = sessions.find((entry) => entry.summary.key === key);
    if (session === undefined) {
      return Promise.reject(transportError("not-found", NO_HOST_MESSAGES.notFound));
    }
    const pending = session.load().then(
      (value) => {
        if (validateReplay(value)) return value;
        const problems = describeReplayProblems(value);
        const detail = problems.length > 0 ? ` ${problems.slice(0, 3).join("; ")}` : "";
        throw transportError("invalid", `${NO_HOST_MESSAGES.invalid}${detail}`);
      },
      () => {
        throw transportError("unreadable", NO_HOST_MESSAGES.unreadable);
      },
    );
    // A failed load may be retried.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
    return pending;
  };

  return {
    kind: "browser",
    canOpenInBrowser: false,
    async listSessions(options?: ListSessionsOptions) {
      const since = options?.since;
      const listed = sessions
        .map((entry) => entry.summary)
        .filter((summary) => since === undefined || summary.lastActivity >= since);
      return options?.limit === undefined ? listed : listed.slice(0, Math.max(0, options.limit));
    },
    loadReplay,
    subscribe(key: string, listener: LiveUpdateListener) {
      let active = true;
      void loadReplay(key).then(
        (replay) => {
          if (!active) return;
          listener({ type: "replay", replay, live: "ended" });
          if (!active) return;
          active = false;
          listener({ type: "ended" });
        },
        (error: unknown) => {
          if (!active) return;
          active = false;
          listener({
            type: "error",
            error: isTransportError(error)
              ? error
              : transportError("internal", NO_HOST_MESSAGES.unreadable),
          });
        },
      );
      return () => {
        active = false;
      };
    },
    openInBrowser() {
      return Promise.reject(transportError("unsupported", NO_HOST_MESSAGES.unsupported));
    },
  };
}
