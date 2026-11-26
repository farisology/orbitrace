/**
 * HostTransport: how the app talks to whatever hosts it. Types only. The app ships one
 * implementation, the no-host transport (`no-host-transport.ts`), which serves the bundled demo
 * replay when there is no editor and no server.
 *
 * The same app bundle runs in two hosts:
 * - an editor tab (ticket #12), where the transport passes messages to the extension;
 * - a browser tab opened by the CLI (ticket #17), where the transport makes HTTP requests
 *   to a loopback server that checks a one-time token.
 *
 * The app (ticket #11) codes only against `HostTransport` for sessions the host can see.
 * It never touches the file system. Only replays and session summaries cross the
 * transport, host to app: never raw transcript lines, parsed sessions, paths or locators,
 * in either direction.
 *
 * Dropped files do not use the transport. A file the user drops onto the app is read and
 * handled inside the app with core: a `.jsonl` transcript goes through `parseSession` and
 * `buildReplay`, a `.replay.json` through `validateReplay`. This is the only case where raw
 * lines exist app-side, and they stay there. There is deliberately no transport method for
 * dropped files.
 */

import type {
  ListSessionsOptions,
  ReplayModel,
  SessionReplayUpdate,
  SessionSummary,
  TransportErrorInfo,
  Unsubscribe,
} from "@orbitrace/core";

/**
 * Why a request failed. Defined once in core (`model/errors.ts`), so the hosts and core's
 * session-to-replay helper use the same codes as the app.
 */
export type { TransportErrorCode } from "@orbitrace/core";

export type HostKind = "editor" | "browser";

/**
 * Error a transport method rejects with. `message` is for display and holds no file paths.
 * The same shape as core's `TransportErrorInfo` (what `toTransportError` returns on the host),
 * so the two cannot drift apart.
 */
export type TransportError = TransportErrorInfo;

/**
 * Pushed to a subscriber while a session is open. The first update of a subscription is the
 * current state (`replay`, or `error` when it cannot be built); later updates follow each
 * change, in order. Consecutive `replay` models keep the append-stability rules in core's
 * `model/replay.ts`, so the app passes each one after the first to
 * `OrreryHandle.updateModel`.
 *
 * - `replay`: the full model at that moment (not a diff) and the session's `LiveStatus`.
 * - `ended`: the session stopped changing (process gone or watch closed). No more updates.
 * - `error`: building or watching failed. No more updates follow.
 *
 * An alias of core's `SessionReplayUpdate`, so a host forwards the replayer's updates as they are.
 */
export type LiveUpdate = SessionReplayUpdate;

export type LiveUpdateListener = (update: LiveUpdate) => void;

export interface HostTransport {
  readonly kind: HostKind;
  /** Whether `openInBrowser` is available in this host. */
  readonly canOpenInBrowser: boolean;
  /** Sessions the host can see, newest first. */
  listSessions(options?: ListSessionsOptions): Promise<readonly SessionSummary[]>;
  /**
   * Build (or read) the replay for one session, once. Rejects with a `TransportError`. For a
   * session the app follows live, use `subscribe` instead of this: its first update is the
   * current state, so there is nothing to order between a load and pushed updates.
   */
  loadReplay(key: string): Promise<ReplayModel>;
  /**
   * Follow one session: snapshot first, then changes. The listener's first update is the
   * current state; each later update is a change. Updates stop after `ended`, `error` or
   * the returned function is called.
   *
   * Each call is its own subscription, even for the same `key`: two subscribers to one
   * session (for example the orrery and an inspector) each get every update, and
   * unsubscribing one leaves the other running. Calling the returned function after the
   * subscription ended does nothing.
   */
  subscribe(key: string, listener: LiveUpdateListener): Unsubscribe;
  /** Open the given session (or the session list) in the user's browser. Editor host only. */
  openInBrowser(key?: string): Promise<void>;
}

/**
 * Message shapes for the editor host, where calls travel as messages between the app
 * (webview) and the extension. Each request carries an `id`, unique per app session; the
 * reply echoes it.
 *
 * Subscriptions are keyed by subscription id, not by session key. The `id` of a `subscribe`
 * request is the subscription id. The host replies with a `result` (value `null`) to that id,
 * then sends `live` messages carrying the same `subscriptionId`, the first being the current
 * state. `unsubscribe` names the subscription id and ends that subscription only; the host
 * sends no `live` message for it afterwards. After an `ended` or `error` update the host
 * forgets the subscription; a later `unsubscribe` for it still gets a `result`.
 */
export type TransportRequest =
  | {
      readonly id: number;
      readonly method: "listSessions";
      readonly params: { readonly options?: ListSessionsOptions };
    }
  | {
      readonly id: number;
      readonly method: "loadReplay";
      readonly params: { readonly key: string };
    }
  | {
      /** Also the subscription id. */
      readonly id: number;
      readonly method: "subscribe";
      readonly params: { readonly key: string };
    }
  | {
      readonly id: number;
      readonly method: "unsubscribe";
      /** The `id` of the `subscribe` request that started the subscription. */
      readonly params: { readonly subscriptionId: number };
    }
  | {
      readonly id: number;
      readonly method: "openInBrowser";
      readonly params: { readonly key?: string };
    };

export type TransportMethod = TransportRequest["method"];

/** Messages from the host to the app: a reply to a request, or a pushed live update. */
export type TransportMessage =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly error: TransportError }
  | {
      readonly kind: "live";
      /** The subscription this update belongs to. Route by this, not by `key`. */
      readonly subscriptionId: number;
      /** Session key, for logging and display only. */
      readonly key: string;
      readonly update: LiveUpdate;
    };
