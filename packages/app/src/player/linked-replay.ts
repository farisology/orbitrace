/**
 * A replay named in the page link: `?replay=<path>`, so a host can put a replay file next to
 * the player and link to it.
 *
 * Only a path on the page's own origin is fetched. A link to any other origin is refused with
 * a message and never fetched (lead's decision on #19): a public page that fetches whatever URL
 * a link names would let anyone use it to track visitors or to send requests elsewhere. The
 * page's Content-Security-Policy (`connect-src 'self'`) enforces the same rule in the browser.
 *
 * The body is read up to `MAX_REPLAY_BYTES` and then checked like an opened replay file.
 */

import type { FileLoadError, FileLoadResult } from "../load-file";
import { replayFromJson } from "../load-file";
import type { FetchFunction } from "../http-transport";
import { PLAYER_MESSAGES } from "./messages";
import { MAX_REPLAY_BYTES, formatMegabytes } from "./open-file";

/** The query parameter that names a replay to open. */
export const REPLAY_PARAM = "replay";

/** The page the player runs in: `window.location` in the browser. */
export interface PlayerPage {
  readonly href: string;
  readonly origin: string;
  readonly search: string;
}

export type LinkResolution =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly error: FileLoadError };

const refuse = (title: string, problems: readonly string[] = []) => ({
  ok: false as const,
  error: { title, problems },
});

/** The raw `replay` parameter of a query string, or `null` when the link has none. */
export function readReplayParam(search: string): string | null {
  return new URLSearchParams(search).get(REPLAY_PARAM);
}

/**
 * Resolve a `replay` parameter against the page. Accepted: a relative path, or an absolute
 * http(s) URL on the page's own origin, without a user name or password. Refused, with a
 * message: anything else, including another origin, `data:`, `blob:` and `javascript:` URLs.
 */
export function resolveReplayLink(
  raw: string,
  page: Pick<PlayerPage, "href" | "origin">,
): LinkResolution {
  if (raw.trim() === "") return refuse(PLAYER_MESSAGES.linkEmpty);
  let url: URL;
  try {
    url = new URL(raw, page.href);
  } catch {
    return refuse(PLAYER_MESSAGES.linkInvalid);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // A relative path on a page opened from disk resolves to file:, which no browser fetches.
    return page.origin.startsWith("http")
      ? refuse(PLAYER_MESSAGES.linkCrossOrigin, [PLAYER_MESSAGES.linkCrossOriginHelp])
      : refuse(PLAYER_MESSAGES.linkNotHttp);
  }
  if (url.origin !== page.origin || url.username !== "" || url.password !== "") {
    return refuse(PLAYER_MESSAGES.linkCrossOrigin, [PLAYER_MESSAGES.linkCrossOriginHelp]);
  }
  return { ok: true, url };
}

/** The header label for a linked replay: `Linked replay: <file name>`. */
export function linkLabel(url: URL): string {
  const segment = url.pathname.split("/").pop() ?? "";
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // Keep the encoded form.
  }
  return name === "" ? "Linked replay" : `Linked replay: ${name}`;
}

export type LimitedRead =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly tooLarge: true };

/**
 * Read a response body as UTF-8 text, stopping as soon as it passes `limit` bytes. A declared
 * `Content-Length` over the limit is refused before any of the body is read.
 */
export async function readLimited(
  response: Response,
  limit: number = MAX_REPLAY_BYTES,
): Promise<LimitedRead> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, tooLarge: true };
  }
  const body = response.body;
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) return { ok: false, tooLarge: true };
    return { ok: true, text: new TextDecoder().decode(bytes) };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { ok: true, text: text + decoder.decode() };
}

/**
 * Fetch a resolved same-origin replay link and check it as a replay. A response that ends on
 * another origin (after a redirect) is refused, as is one over the size limit or not a replay.
 */
export async function fetchLinkedReplay(
  url: URL,
  page: Pick<PlayerPage, "origin">,
  fetchFn: FetchFunction = (input, init) => globalThis.fetch(input, init),
  limit: number = MAX_REPLAY_BYTES,
): Promise<FileLoadResult> {
  let response: Response;
  try {
    response = await fetchFn(url.href, { method: "GET", credentials: "same-origin" });
  } catch {
    return refuse(PLAYER_MESSAGES.linkFailed);
  }
  if (response.url !== "") {
    let finalOrigin: string | null;
    try {
      finalOrigin = new URL(response.url).origin;
    } catch {
      finalOrigin = null;
    }
    if (finalOrigin !== page.origin) {
      await response.body?.cancel().catch(() => {});
      return refuse(PLAYER_MESSAGES.linkCrossOrigin, [PLAYER_MESSAGES.linkCrossOriginHelp]);
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return refuse(PLAYER_MESSAGES.linkFailed, [PLAYER_MESSAGES.linkStatus(response.status)]);
  }
  let read: LimitedRead;
  try {
    read = await readLimited(response, limit);
  } catch {
    return refuse(PLAYER_MESSAGES.linkFailed);
  }
  if (!read.ok) return refuse(PLAYER_MESSAGES.linkTooLarge(formatMegabytes(limit)));
  return replayFromJson(read.text);
}
