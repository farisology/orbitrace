/**
 * Turns the app's built `index.html` into the page an editor tab shows. No vscode dependency,
 * so it is unit tested.
 *
 * - A strict Content-Security-Policy: scripts, styles, images and fonts only from the webview
 *   resource origin, no inline script or style, no network (`connect-src 'none'`), no frames,
 *   no forms, no plugins.
 * - A `<base>` element pointing at the app folder's webview URI, so the relative asset URLs of
 *   the app build (Vite `base: "./"`) and the app's own relative image URLs resolve inside the
 *   app folder.
 * - The host meta tags from the wire layout on #12: `orbitrace-host` = `editor` makes the app
 *   use the webview transport; `orbitrace-session` preselects a session by key. A page built
 *   for the demo carries neither tag, so the app shows its bundled demo. The names and the value
 *   come from core's host protocol (`HOST_META_NAME`, `EDITOR_HOST_META_VALUE`,
 *   `SESSION_META_NAME`, #96, #107), the same constants the app reads them with.
 */

import { EDITOR_HOST_META_VALUE, HOST_META_NAME, SESSION_META_NAME } from "@orbitrace/core";

export interface WebviewPageOptions {
  /** `webview.cspSource` of the panel. */
  readonly cspSource: string;
  /** `webview.asWebviewUri(<app folder>)` as a string. A trailing `/` is added if missing. */
  readonly baseUri: string;
  /**
   * `editor`: the app talks to this host over messages. `demo`: no host tags, so the app
   * serves its bundled demo and never posts a message.
   */
  readonly mode: "editor" | "demo";
  /** Session to preselect, editor mode only. */
  readonly sessionKey?: string;
}

/**
 * Characters that end or break a double-quoted HTML attribute value, escaped. Every attribute
 * written here is double-quoted, so single quotes (as in `'none'`) stay readable.
 */
export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A scheme or scheme/host source expression, e.g. `https://*.vscode-cdn.net` or `https:`. */
const SCHEME_HOST_SOURCE = /^[a-z][a-z0-9+.-]*:(\/\/[^\s;,'"<>]+)?$/i;

/**
 * Splits `webview.cspSource` into its source expressions. VS Code sends a space-separated
 * list (for example `'self' https://*.vscode-cdn.net`, with the extension URL in front when
 * the extension is served over http(s)). Each token must be `'self'` or a scheme/host source;
 * an empty value, or one with `;`, `,`, `"`, `<`, `>` or a line break, throws, so a malformed
 * value cannot add directives or keywords such as `'unsafe-inline'`.
 */
export function cspSourceTokens(cspSource: string): string[] {
  if (/[;,"<>\r\n]/.test(cspSource)) {
    throw new Error("The webview CSP source contains a character that could add directives.");
  }
  const tokens = cspSource.split(/[ \t]+/).filter((token) => token !== "");
  if (tokens.length === 0) throw new Error("The webview CSP source is empty.");
  for (const token of tokens) {
    if (token !== "'self'" && !SCHEME_HOST_SOURCE.test(token)) {
      throw new Error(`The webview CSP source has an unexpected expression: ${token}`);
    }
  }
  return tokens;
}

/**
 * The Content-Security-Policy for the page. Every directive that allows the webview origin
 * uses all source expressions from `cspSourceTokens`; anything malformed throws.
 */
export function contentSecurityPolicy(cspSource: string): string {
  const source = cspSourceTokens(cspSource).join(" ");
  return [
    "default-src 'none'",
    `script-src ${source}`,
    `style-src ${source}`,
    `img-src ${source} data:`,
    `font-src ${source}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${source}`,
  ].join("; ");
}

/** The elements injected at the start of `<head>`, in order. */
export function headElements(options: WebviewPageOptions): string[] {
  const base = options.baseUri.endsWith("/") ? options.baseUri : `${options.baseUri}/`;
  const elements = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(contentSecurityPolicy(options.cspSource))}">`,
    `<base href="${escapeAttribute(base)}">`,
  ];
  if (options.mode === "editor") {
    elements.push(
      `<meta name="${escapeAttribute(HOST_META_NAME)}" content="${escapeAttribute(EDITOR_HOST_META_VALUE)}">`,
    );
    if (options.sessionKey !== undefined && options.sessionKey !== "") {
      elements.push(
        `<meta name="${escapeAttribute(SESSION_META_NAME)}" content="${escapeAttribute(options.sessionKey)}">`,
      );
    }
  }
  return elements;
}

/** `value` with every regular-expression special character escaped. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `<meta>` tag naming either host meta tag, in any case and quoting, with trailing space. */
const HOST_META_TAG = new RegExp(
  `<meta\\b[^>]*name\\s*=\\s*["']?(?:${escapeRegExp(HOST_META_NAME)}|${escapeRegExp(SESSION_META_NAME)})["']?[^>]*>\\s*`,
  "gi",
);

/**
 * The page for an editor tab. Throws when `indexHtml` has an inline script (a `<script>`
 * without `src`) or has no `<head>`, because the policy would block the first and the tags
 * need the second.
 */
export function buildWebviewHtml(indexHtml: string, options: WebviewPageOptions): string {
  const scripts = indexHtml.match(/<script\b[^>]*>/gi) ?? [];
  if (scripts.some((tag) => !/\ssrc\s*=/i.test(tag))) {
    throw new Error("The app page has an inline script, which the webview policy blocks.");
  }
  // Remove any policy or host tags the page already has, so only the ones set here apply.
  const cleaned = indexHtml
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi, "")
    .replace(HOST_META_TAG, "")
    .replace(/<base\b[^>]*>\s*/gi, "");
  const head = /<head\b[^>]*>/i.exec(cleaned);
  if (head === null) throw new Error("The app page has no <head> element.");
  const at = head.index + head[0].length;
  const injected = headElements(options)
    .map((element) => `\n    ${element}`)
    .join("");
  return `${cleaned.slice(0, at)}${injected}${cleaned.slice(at)}`;
}
