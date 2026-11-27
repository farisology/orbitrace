/**
 * Saving an exported replay from the editor tab (#168). Lead-approved, additive: one request and
 * its reply, beside the `TransportRequest` union in `../model/transport.ts`, which stays as it is.
 *
 * A webview cannot download a file, so the app sends the replay text it made with `exportReplay`
 * to the editor host as `{ id, method: "saveReplay", params: { data } }`. The host checks it with
 * `checkSaveReplayRequest`, then parses it, checks it with `validateReplay` and writes it where
 * the user chose in the editor's own save dialog. The webview never sends a path or a file name:
 * the host suggests the name `exportReplay` gives (`REPLAY_EXPORT_FILE_NAME`) in its dialog.
 *
 * The host answers with the usual `TransportMessage`: a `result` whose value is a
 * `SaveReplayResult` (`{ outcome: "saved" }` or `{ outcome: "cancelled" }`), or an `error` with a
 * fixed `{ code, message }` that names no path.
 *
 * Browser-safe and free of runtime imports from outside core.
 */

import { isRequestId, type RequestProblem } from "./index.js";

/** The method name of the save request. Not a `TransportMethod`: only the editor host takes it. */
export const SAVE_REPLAY_METHOD = "saveReplay";

/**
 * Largest replay text a host saves, in UTF-8 bytes: 50 MiB, the same limit as a replay file the
 * public player opens.
 */
export const MAX_SAVED_REPLAY_BYTES = 50 * 1024 * 1024;

/** The request the app posts to save a replay. `data` is the text `exportReplay` returned. */
export interface SaveReplayRequest {
  readonly id: number;
  readonly method: typeof SAVE_REPLAY_METHOD;
  readonly params: { readonly data: string };
}

/** What happened to a save request the host accepted. */
export type SaveReplayOutcome = "saved" | "cancelled";

/** The `result` value of a save request. */
export interface SaveReplayResult {
  readonly outcome: SaveReplayOutcome;
}

/**
 * What `checkSaveReplayRequest` found: `null` when the value is not a save request at all (its
 * `method` is not `saveReplay`), so the host hands it to `checkTransportRequest` instead.
 * `too-large` is a well-formed request whose text is over `MAX_SAVED_REPLAY_BYTES`.
 */
export type SaveReplayRequestCheck =
  | { readonly ok: true; readonly request: SaveReplayRequest }
  | {
      readonly ok: false;
      readonly problem: Exclude<RequestProblem, "unknown-method"> | "too-large";
      readonly id: number | null;
    };

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The number of bytes `text` takes as UTF-8. A lone surrogate counts as the three bytes of the
 * U+FFFD an encoder writes for it.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Check one incoming message as a save request. On success the request is a fresh object holding
 * only `id`, `method` and `params.data`. Returns `null` when the value is not a save request, so
 * every other message goes through `checkTransportRequest` as before.
 */
export function checkSaveReplayRequest(value: unknown): SaveReplayRequestCheck | null {
  if (!isRecord(value) || value.method !== SAVE_REPLAY_METHOD) return null;
  if (!isRequestId(value.id)) return { ok: false, problem: "no-id", id: null };
  const id = value.id;
  const params = value.params;
  if (!isRecord(params) || typeof params.data !== "string" || params.data === "") {
    return { ok: false, problem: "bad-params", id };
  }
  // Each UTF-16 unit is at most 3 bytes, so a short text needs no count.
  if (params.data.length * 3 > MAX_SAVED_REPLAY_BYTES) {
    if (utf8ByteLength(params.data) > MAX_SAVED_REPLAY_BYTES) {
      return { ok: false, problem: "too-large", id };
    }
  }
  return { ok: true, request: { id, method: SAVE_REPLAY_METHOD, params: { data: params.data } } };
}

/** Read the `result` value of a save request. Returns `null` for anything else. */
export function parseSaveReplayResult(value: unknown): SaveReplayResult | null {
  if (!isRecord(value)) return null;
  return value.outcome === "saved" || value.outcome === "cancelled"
    ? { outcome: value.outcome }
    : null;
}
