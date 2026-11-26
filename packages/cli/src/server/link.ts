/**
 * The link the CLI prints and opens: `http://127.0.0.1:<port>/#t=<token>&key=<session key>`.
 *
 * The token and the key are in the fragment, so the browser never sends them in a request line
 * or a Referer header. The app reads the fragment with `URLSearchParams` and removes it from the
 * address bar. The fragment and its encoder are core's (`hostLinkFragment`, #92), so the CLI and
 * the app cannot drift apart.
 */

import { hostLinkFragment } from "@orbitrace/core";

/**
 * A fragment value, percent-encoded as UTF-8 outside `A-Z a-z 0-9 - . _ ~ :`. Core's, re-exported
 * so existing imports keep working.
 */
export { encodeFragmentValue } from "@orbitrace/core";

/** The link to the app at `origin` (`http://127.0.0.1:<port>`), with the token and the key. */
export function buildLink(origin: string, token: string, key?: string): string {
  return `${origin}/${hostLinkFragment(token, key)}`;
}
