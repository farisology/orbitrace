/**
 * The editor side of `HostTransport` (ticket #12): `TransportRequest` messages in from the
 * webview, `TransportMessage` messages out, answered through the shared session replayer from
 * `@orbitrace/core/node` (#75).
 *
 * Only session summaries, replay models and `{ code, message }` errors are sent. The replayer
 * keeps paths and locators on the host. No vscode dependency: the panel glue passes in a
 * `post` function, so this module is unit tested with fakes.
 *
 * Saving an exported replay (#168): the app sends core's additive `saveReplay` request with the
 * replay text only, never a path. This host checks its shape and size (`checkSaveReplayRequest`),
 * parses it, checks it with `validateReplay`, writes it out again through `exportReplay` (so only
 * allow-listed fields can reach the file) and hands that text to `saveReplay`, which asks the
 * user where to save it. Every refusal and failure is answered with a fixed message.
 */

import {
  MAX_SAVED_REPLAY_BYTES,
  checkSaveReplayRequest,
  checkTransportRequest,
  exportReplay,
  toTransportError,
  validateReplay,
  type SaveReplayOutcome,
  type SaveReplayRequestCheck,
  type TransportErrorInfo,
  type TransportMessage,
  type TransportRequest,
} from "@orbitrace/core";
import type { SessionReplayer } from "@orbitrace/core/node";

/** Fixed messages of the errors this host sends itself. No path, key or session id. */
export const MESSAGE_HOST_ERRORS = {
  unknownMethod: "This request is not supported by the editor host.",
  badParams: "The request was malformed.",
  duplicateSubscription: "A subscription with this id is already open.",
  openInBrowser: "Opening a session in the browser is not available from the editor yet.",
  saveUnsupported: "Saving a replay is not available in this tab.",
  saveTooLarge: `The replay is larger than ${MAX_SAVED_REPLAY_BYTES / (1024 * 1024)} MB and was not saved.`,
  saveInvalid: "The replay did not pass the replay format check and was not saved.",
  saveFailed: "The replay file could not be written.",
} as const;

/** What the host needs from the replayer. `createNodeSessionReplayer()` provides it. */
export type MessageHostReplayer = Pick<SessionReplayer, "list" | "load" | "follow">;

export interface MessageHostOptions {
  readonly replayer: MessageHostReplayer;
  /**
   * Sends one message to the webview. May return a promise (the webview API does); a rejected
   * or thrown send is ignored, because the panel may close at any moment.
   */
  readonly post: (message: TransportMessage) => unknown;
  /**
   * Asks the user where to save a checked replay text and writes it there (#168): resolves
   * `saved`, or `cancelled` when the user closed the dialog. Rejects when the file could not be
   * written; the reason is not passed on. Without it, a save request is answered `unsupported`.
   */
  readonly saveReplay?: (data: string) => Promise<SaveReplayOutcome>;
}

export interface MessageHost {
  /**
   * Handle one message from the webview. Invalid messages are answered with an `error` when
   * they carry a usable `id`, and dropped otherwise. Resolves once the reply is sent. Never
   * rejects.
   */
  handle(message: unknown): Promise<void>;
  /** Number of open subscriptions. */
  readonly subscriptionCount: number;
  /** Stop every subscription and ignore every later message. Safe to call more than once. */
  dispose(): void;
}

/** Create a message host for one webview panel. */
export function createMessageHost(options: MessageHostOptions): MessageHost {
  const { replayer } = options;
  const subscriptions = new Map<number, () => void>();
  let disposed = false;

  const send = (message: TransportMessage): void => {
    if (disposed) return;
    try {
      const sent = options.post(message);
      if (isThenable(sent)) sent.then(undefined, () => undefined);
    } catch {
      // The panel was closed while a reply was on its way.
    }
  };

  const reply = (id: number, result: unknown): void => send({ kind: "result", id, result });
  const fail = (id: number, error: TransportErrorInfo): void => send({ kind: "error", id, error });

  const subscribe = (id: number, key: string): void => {
    if (subscriptions.has(id)) {
      fail(id, { code: "internal", message: MESSAGE_HOST_ERRORS.duplicateSubscription });
      return;
    }
    // Registered before following, so an update delivered during `follow` finds the entry.
    const follow: { stop?: () => void } = {};
    let finished = false;
    subscriptions.set(id, () => {
      finished = true;
      follow.stop?.();
    });
    reply(id, null);
    follow.stop = replayer.follow(key, (update) => {
      if (disposed || finished || subscriptions.get(id) === undefined) return;
      send({ kind: "live", subscriptionId: id, key, update });
      if (update.type === "ended" || update.type === "error") {
        finished = true;
        subscriptions.delete(id);
      }
    });
    if (finished) follow.stop();
  };

  /** Check, re-export and save one replay text, then answer with the outcome or a fixed error. */
  const save = async (checked: SaveReplayRequestCheck): Promise<void> => {
    if (!checked.ok) {
      if (checked.id === null) return;
      fail(checked.id, {
        code: "bad-request",
        message:
          checked.problem === "too-large"
            ? MESSAGE_HOST_ERRORS.saveTooLarge
            : MESSAGE_HOST_ERRORS.badParams,
      });
      return;
    }
    const { id, params } = checked.request;
    if (options.saveReplay === undefined) {
      fail(id, { code: "unsupported", message: MESSAGE_HOST_ERRORS.saveUnsupported });
      return;
    }
    let data: string;
    try {
      const value: unknown = JSON.parse(params.data);
      if (!validateReplay(value)) throw new Error("not a replay");
      // Written again from the allow-list: the same bytes for a file the app made with
      // `exportReplay`, and nothing beyond the allow-listed fields for anything else.
      data = exportReplay(value).data;
    } catch {
      fail(id, { code: "invalid", message: MESSAGE_HOST_ERRORS.saveInvalid });
      return;
    }
    let outcome: SaveReplayOutcome;
    try {
      outcome = await options.saveReplay(data);
    } catch {
      // A file system error names the path it failed on: never passed on.
      fail(id, { code: "internal", message: MESSAGE_HOST_ERRORS.saveFailed });
      return;
    }
    reply(id, { outcome });
  };

  const run = async (request: TransportRequest): Promise<void> => {
    switch (request.method) {
      case "listSessions":
        reply(request.id, await replayer.list(request.params.options));
        return;
      case "loadReplay":
        reply(request.id, await replayer.load(request.params.key));
        return;
      case "subscribe":
        subscribe(request.id, request.params.key);
        return;
      case "unsubscribe": {
        const stop = subscriptions.get(request.params.subscriptionId);
        subscriptions.delete(request.params.subscriptionId);
        stop?.();
        reply(request.id, null);
        return;
      }
      case "openInBrowser":
        fail(request.id, { code: "unsupported", message: MESSAGE_HOST_ERRORS.openInBrowser });
        return;
    }
  };

  return {
    async handle(message: unknown): Promise<void> {
      if (disposed) return;
      const saving = checkSaveReplayRequest(message);
      if (saving !== null) {
        await save(saving);
        return;
      }
      const parsed = checkTransportRequest(message);
      if (!parsed.ok) {
        if (parsed.id === null) return;
        // An unknown method is one this host does not offer; anything else malformed is a bad
        // request (#95).
        fail(
          parsed.id,
          parsed.problem === "unknown-method"
            ? { code: "unsupported", message: MESSAGE_HOST_ERRORS.unknownMethod }
            : { code: "bad-request", message: MESSAGE_HOST_ERRORS.badParams },
        );
        return;
      }
      try {
        await run(parsed.request);
      } catch (error) {
        // `toTransportError` keeps a replayer error's code and fixed message and turns anything
        // else into `internal`, so the text of an unknown error (which may hold a path) is
        // never passed on.
        fail(parsed.request.id, toTransportError(error));
      }
    },
    get subscriptionCount(): number {
      return subscriptions.size;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const stops = [...subscriptions.values()];
      subscriptions.clear();
      for (const stop of stops) {
        try {
          stop();
        } catch {
          // Stopping one subscription must not keep the others open.
        }
      }
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
