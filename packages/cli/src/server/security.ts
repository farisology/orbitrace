/**
 * Security checks of the loopback server (#17): the per-start token, the Host header check,
 * the Origin and fetch-metadata check, and the response headers every reply carries.
 *
 * The threat model is in docs/architecture.md ("Loopback server and routes"). In short: any web
 * page open in the user's browser can send requests to 127.0.0.1, and a DNS rebinding page can
 * even read the replies under its own name. These checks make sure only the page the CLI opened,
 * holding the token from the link, can read session data.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The only address the server listens on. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Bytes of randomness in a token. The ticket asks for at least 32. */
export const TOKEN_BYTES = 32;

/** A new random token: 32 bytes from the system's secure random source, base64url (43 chars). */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The token of an `Authorization: Bearer <token>` header, or `null` when the header is missing
 * or has another scheme. The scheme is matched without regard to case, as HTTP says.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i.exec(header);
  return match === null ? null : (match[1] as string);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether `given` is the token, compared in constant time. Both sides are hashed first, so the
 * comparison takes the same time whatever the length of `given`.
 */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null || expected === "") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The Host header values the server answers to: `127.0.0.1:<port>` and `localhost:<port>`. */
export function allowedHosts(port: number): readonly string[] {
  return [`${LOOPBACK_HOST}:${port}`, `localhost:${port}`];
}

/**
 * Whether a Host header names this server. Anything else (another name, another port, a
 * missing header) is refused: a DNS rebinding page sends its own name as the Host.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (typeof host !== "string") return false;
  return allowedHosts(port).includes(host.toLowerCase());
}

/** The origins of the page the server serves. */
export function allowedOrigins(port: number): readonly string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

/**
 * Whether the request comes from this server's own page, judged by the headers a browser adds.
 * A missing header is accepted (a non-browser client sends none, and the token is still
 * required); a present one must say "same origin".
 *
 * - `Origin`: browsers send it on every POST. It must be one of `allowedOrigins`.
 * - `Sec-Fetch-Site`: `same-origin`, or `none` (typed in the address bar). `same-site` is
 *   refused, because a page on another port of 127.0.0.1 is the same site.
 */
export function isSameOriginRequest(
  origin: string | undefined,
  fetchSite: string | undefined,
  port: number,
): boolean {
  if (origin !== undefined && !allowedOrigins(port).includes(origin.toLowerCase())) return false;
  if (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

/**
 * Content-Security-Policy of every reply. The app bundle is a module script and a stylesheet
 * from the same origin and nothing inline; it talks only to this server.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Headers sent with every reply, static or API. No CORS header is ever sent, so a page from
 * another origin cannot read a reply. `Cache-Control: no-store` keeps nothing on disk.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

/**
 * Whether a Content-Type header is JSON. Only `application/json`, with an optional charset, is
 * accepted: the content types a plain HTML form can send (`text/plain`,
 * `application/x-www-form-urlencoded`, `multipart/form-data`) are refused, and any other type
 * makes the browser ask first with a preflight, which the server refuses.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (typeof header !== "string") return false;
  const [type, ...params] = header.split(";").map((part) => part.trim().toLowerCase());
  if (type !== "application/json") return false;
  return params.every((param) => param === "" || /^charset="?utf-8"?$/.test(param));
}
