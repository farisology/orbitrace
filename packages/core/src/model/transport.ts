/**
 * The messages between the app and its hosts (#96). Moved here from `@orbitrace/app/transport`,
 * which re-exports every name, so the CLI and the editor extension type their side of the
 * protocol against core alone and a published host's declarations never name the app.
 *
 * The wire layout around these messages (meta tags, link fragment, loopback routes) is the lead's
 * decision on #17 and lives with the shared checks in `../protocol/index.ts`.
 *
 * Each request carries an `id`, unique per app session; the reply echoes it. Subscriptions are
 * keyed by subscription id, not by session key. The `id` of a `subscribe` request is the
 * subscription id. The host replies with a `result` (value `null`) to that id, then sends `live`
 * messages carrying the same `subscriptionId`, the first being the current state. `unsubscribe`
 * names the subscription id and ends that subscription only; the host sends no `live` message for
 * it afterwards. After an `ended` or `error` update the host forgets the subscription; a later
 * `unsubscribe` for it still gets a `result`.
 *
 * Only session summaries, replay models and `{ code, message }` errors cross: never raw transcript
 * lines, parsed sessions, paths or locators, in either direction.
 */

import type { TransportErrorInfo } from "../host/errors.js";
import type { SessionReplayUpdate } from "../host/session-replayer.js";
import type { ListSessionsOptions } from "./sources.js";

/** One request from the app to its host. */
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

/** Every `TransportMethod`, in the order of the union above. */
export const TRANSPORT_METHODS = [
  "listSessions",
  "loadReplay",
  "subscribe",
  "unsubscribe",
  "openInBrowser",
] as const satisfies readonly TransportMethod[];

/** A `TransportRequest` without its `id`, which the sending transport assigns. */
export type TransportRequestBody = TransportRequest extends infer R
  ? R extends { readonly id: number }
    ? Omit<R, "id">
    : never
  : never;

/** Messages from the host to the app: a reply to a request, or a pushed live update. */
export type TransportMessage =
  | { readonly kind: "result"; readonly id: number; readonly result: unknown }
  | { readonly kind: "error"; readonly id: number; readonly error: TransportErrorInfo }
  | {
      readonly kind: "live";
      /** The subscription this update belongs to. Route by this, not by `key`. */
      readonly subscriptionId: number;
      /** Session key, for logging and display only. */
      readonly key: string;
      readonly update: SessionReplayUpdate;
    };

/** Body of `POST /api/live`. `id` is the subscription id the `live` messages carry. */
export interface LiveRequest {
  readonly id: number;
  readonly key: string;
}
