/**
 * The wire layout between the app and its two hosts (lead's decision on #17). Defined once in
 * `@orbitrace/core` (#92, #96), so the app's client transports, the CLI's loopback server and the
 * editor extension use the same names, routes, checks and limits. Every name is re-exported here
 * so existing imports keep working.
 *
 * Only `readHostFragment` lives here: reading the page fragment is the app's side of the link,
 * and it uses the browser's `URLSearchParams`.
 *
 * Also built as plain JavaScript for the hosts (`@orbitrace/app`, see `index.ts`); its only
 * runtime import is `@orbitrace/core`, a dependency of this package.
 */

import { SESSION_FRAGMENT_PARAM, TOKEN_FRAGMENT_PARAM } from "@orbitrace/core";

export {
  EDITOR_HOST_META_VALUE,
  HOST_META_NAME,
  LIVE_PATH,
  RPC_METHODS,
  RPC_PATH,
  SESSION_FRAGMENT_PARAM,
  SESSION_META_NAME,
  TOKEN_FRAGMENT_PARAM,
  encodeLiveLine,
  hostLinkFragment,
  isLiveUpdate,
  isTransportError,
  parseLiveRequest,
  parseTransportMessage,
  parseTransportRequest,
  transportError,
} from "@orbitrace/core";
export type { LiveRequest, TransportRequestBody } from "@orbitrace/core";

/** What the app reads from the page fragment of a loopback link. */
export interface HostFragment {
  readonly token: string | null;
  readonly sessionKey: string | null;
}

/** Read the token and session key from a page fragment such as `#t=abc&key=s1`. */
export function readHostFragment(hash: string): HostFragment {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get(TOKEN_FRAGMENT_PARAM);
  const sessionKey = params.get(SESSION_FRAGMENT_PARAM);
  return {
    token: token === null || token === "" ? null : token,
    sessionKey: sessionKey === null || sessionKey === "" ? null : sessionKey,
  };
}
