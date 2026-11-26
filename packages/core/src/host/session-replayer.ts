/**
 * Ticket #75: the shared host-side helper that turns a session key into a replay.
 *
 * The editor host (#12) and the CLI with its loopback server (#16, #17) both need the same
 * chain: find the `SessionRef` for a key, `adapter.openSession` -> `parseSession` ->
 * `buildReplay` (with the last snapshot as `previous` while following) -> schema check, and turn
 * every failure into a `TransportErrorCode` with a path-free message. Writing it once keeps the
 * append-stability bookkeeping and the error mapping from drifting apart between hosts.
 *
 * It is also the boundary `docs/architecture.md` relies on: raw lines, `ParsedSession` and
 * `SessionRef` stay inside this module. What it hands out for the app is a `ReplayModel`, a
 * `SessionSummary` or a `{ code, message }` error.
 *
 * This file imports no Node module, but it is exported only from `@orbitrace/core/node`, next to
 * `createNodeSessionReplayer`, which fills in the Claude Code adapter and the process's roots.
 */

import type { BuildReplayOptions } from "../api.js";
import { describeReplayProblems } from "../export/validate.js";
import type { ParsedSession } from "../model/parsed.js";
import type { ReplayModel } from "../model/replay.js";
import type {
  ListSessionsOptions,
  LiveStatus,
  SessionRef,
  SessionSummary,
  SourceAdapter,
  SourceRoot,
  Unsubscribe,
} from "../model/sources.js";
import { parseSession } from "../parser/index.js";
import { buildReplay } from "../replay/index.js";
import { findSessionByKey, listSessions, toSessionSummary } from "../sources/index.js";
import { SessionReplayError, toTransportError, type TransportErrorInfo } from "./errors.js";

/** Roots to search: a fixed list, or a function called each time the replayer lists sessions. */
export type SessionRootsSource = readonly SourceRoot[] | (() => Promise<readonly SourceRoot[]>);

/** Builder options the replayer passes to every build. It manages `previous` itself. */
export type SessionReplayBuildOptions = Omit<BuildReplayOptions, "previous">;

export interface SessionReplayerOptions {
  /** Adapters, as for `listSessions`. The first adapter whose `runtime` matches a session opens it. */
  readonly adapters: readonly SourceAdapter[];
  /** Where sessions are looked for. A function is called again on every listing. */
  readonly roots: SessionRootsSource;
  /** Passed to every `buildReplay` call. Default: the builder's defaults. */
  readonly build?: SessionReplayBuildOptions;
}

/**
 * One update of `SessionReplayer.follow`. The same shape as `LiveUpdate` in
 * `@orbitrace/app/transport`, so a host forwards it as it is. `error` is a plain object, so it
 * survives structured clone.
 */
export type SessionReplayUpdate =
  /** The full model at that moment. The first update is the current state. */
  | { readonly type: "replay"; readonly replay: ReplayModel; readonly live: LiveStatus }
  /** No more updates follow, because the adapter cannot watch this session. */
  | { readonly type: "ended" }
  /** Building or watching failed. No more updates follow. */
  | { readonly type: "error"; readonly error: TransportErrorInfo };

export type SessionReplayListener = (update: SessionReplayUpdate) => void;

/** Messages of the errors the replayer throws or sends. Fixed text: no path, key or session id. */
export const SESSION_REPLAY_MESSAGES = {
  notFound: "No session with that key.",
  unreadable: "The session transcript could not be read.",
  invalid: "The replay built from this session did not pass the replay format check.",
  buildFailed: "The replay could not be built from this session.",
  rootsFailed: "The session folders could not be resolved.",
  watchFailed: "The session could not be watched for changes.",
} as const;

export interface SessionReplayer {
  /**
   * Sessions under the roots, newest first, as path-free summaries. Also remembers the
   * `SessionRef` of each one, so a key from this list is found without listing again.
   */
  list(options?: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  /**
   * The `SessionRef` for a key. A key seen in an earlier `list` or `find` is answered from
   * memory; any other key lists the roots once more. Rejects with a `SessionReplayError`
   * (`not-found`, or `internal` when the roots cannot be resolved). The ref holds paths: keep it
   * on the host.
   */
  find(key: string): Promise<SessionRef>;
  /**
   * Build the replay for one session, once: a fresh build with no `previous`, checked against
   * the replay v1 schema. Rejects with a `SessionReplayError` whose code is `not-found`,
   * `unreadable`, `invalid` or `internal`.
   */
  load(key: string): Promise<ReplayModel>;
  /**
   * Follow one session. The first update is the current state; each change reported by the
   * adapter's `watchSession` rebuilds the replay with the last model sent as `previous`, so
   * consecutive models keep the append-stability rules and the app can pass each one after the
   * first to `OrreryHandle.updateModel`.
   *
   * - Changes that arrive while a build runs are merged into one more build, so updates are in
   *   order and never overlap.
   * - When the adapter has no `watchSession`, the current state is followed by `ended`.
   * - A failure sends one `error` update and stops the subscription.
   * - Each call is its own subscription with its own last model. The returned function stops it;
   *   calling it again, or after `ended` or `error`, does nothing. No update is sent after it.
   */
  follow(key: string, listener: SessionReplayListener): Unsubscribe;
}

function adapterFor(
  adapters: readonly SourceAdapter[],
  ref: SessionRef,
): SourceAdapter | undefined {
  return adapters.find((adapter) => adapter.runtime === ref.runtime);
}

/** Create a session replayer over the given adapters and roots. */
export function createSessionReplayer(options: SessionReplayerOptions): SessionReplayer {
  const { adapters, roots } = options;
  const buildOptions: SessionReplayBuildOptions = options.build ?? {};
  const known = new Map<string, SessionRef>();

  async function currentRoots(): Promise<readonly SourceRoot[]> {
    if (typeof roots !== "function") return roots;
    try {
      return await roots();
    } catch {
      throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.rootsFailed);
    }
  }

  async function list(listOptions?: ListSessionsOptions): Promise<readonly SessionSummary[]> {
    const refs = await listSessions(await currentRoots(), adapters, listOptions);
    for (const ref of refs) known.set(ref.key, ref);
    return refs.map(toSessionSummary);
  }

  async function find(key: string): Promise<SessionRef> {
    if (typeof key !== "string" || key === "") {
      throw new SessionReplayError("not-found", SESSION_REPLAY_MESSAGES.notFound);
    }
    const remembered = known.get(key);
    if (remembered !== undefined) return remembered;
    const ref = await findSessionByKey(await currentRoots(), adapters, key);
    if (ref === null) throw new SessionReplayError("not-found", SESSION_REPLAY_MESSAGES.notFound);
    known.set(key, ref);
    return ref;
  }

  /** open -> parse -> build -> check. Every failure becomes a `SessionReplayError`. */
  async function replayOf(
    ref: SessionRef,
    previous: ReplayModel | undefined,
  ): Promise<ReplayModel> {
    const adapter = adapterFor(adapters, ref);
    if (adapter === undefined) {
      throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.buildFailed);
    }
    let parsed: ParsedSession;
    try {
      // Reading happens lazily while parsing, so a read error can surface in either call.
      parsed = await parseSession(await adapter.openSession(ref));
    } catch {
      throw new SessionReplayError("unreadable", SESSION_REPLAY_MESSAGES.unreadable);
    }
    let model: ReplayModel;
    try {
      model = buildReplay(
        parsed,
        previous === undefined ? buildOptions : { ...buildOptions, previous },
      );
    } catch {
      throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.buildFailed);
    }
    // The problem lines name a JSON pointer and a rule and never quote a value.
    const problems = describeReplayProblems(model);
    if (problems.length > 0) {
      throw new SessionReplayError(
        "invalid",
        `${SESSION_REPLAY_MESSAGES.invalid}\n- ${problems.join("\n- ")}`,
      );
    }
    return model;
  }

  async function load(key: string): Promise<ReplayModel> {
    try {
      return await replayOf(await find(key), undefined);
    } catch (error) {
      if (error instanceof SessionReplayError) throw error;
      throw new SessionReplayError("internal", SESSION_REPLAY_MESSAGES.buildFailed);
    }
  }

  function follow(key: string, listener: SessionReplayListener): Unsubscribe {
    let active = true;
    let stopWatch: Unsubscribe | undefined;
    let ref: SessionRef | undefined;
    let previous: ReplayModel | undefined;
    let building = false;
    let again = false;

    const stop = (): void => {
      active = false;
      const watch = stopWatch;
      stopWatch = undefined;
      if (watch !== undefined) {
        try {
          watch();
        } catch {
          // Stopping a watch must not throw into the host.
        }
      }
    };

    /**
     * Hand one update to the listener. A listener that throws does not stop the subscription
     * or turn into an `error` update; its exception is passed on as a rejected promise, so it
     * is not lost.
     */
    const deliver = (update: SessionReplayUpdate): void => {
      try {
        listener(update);
      } catch (error) {
        // Surfaces as an unhandled rejection, like a throw in any other async callback.
        void Promise.reject(error);
      }
    };

    /** Send a last update and stop. */
    const finish = (update: SessionReplayUpdate): void => {
      if (!active) return;
      stop();
      deliver(update);
    };

    /** Build until no change is pending. Only one loop runs at a time. */
    const rebuild = async (): Promise<void> => {
      if (building) {
        again = true;
        return;
      }
      building = true;
      try {
        do {
          again = false;
          const current = ref as SessionRef;
          const model = await replayOf(current, previous);
          if (!active) return;
          previous = model;
          deliver({ type: "replay", replay: model, live: current.live });
        } while (again && active);
      } catch (error) {
        finish({ type: "error", error: toTransportError(error) });
      } finally {
        building = false;
      }
    };

    const start = async (): Promise<void> => {
      try {
        ref = await find(key);
      } catch (error) {
        finish({ type: "error", error: toTransportError(error) });
        return;
      }
      if (!active) return;
      const adapter = adapterFor(adapters, ref);
      const watch = adapter?.watchSession?.bind(adapter);
      if (watch !== undefined) {
        try {
          const unsubscribe = watch(ref, (changed) => {
            if (!active) return;
            ref = changed;
            void rebuild();
          });
          if (active) stopWatch = unsubscribe;
          else unsubscribe();
        } catch {
          finish({
            type: "error",
            error: { code: "internal", message: SESSION_REPLAY_MESSAGES.watchFailed },
          });
          return;
        }
      }
      await rebuild();
      if (watch === undefined) finish({ type: "ended" });
    };

    void start();
    return () => {
      if (active) stop();
    };
  }

  return { list, find, load, follow };
}
