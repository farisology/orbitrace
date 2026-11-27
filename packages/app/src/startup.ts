/**
 * Start-up selection (lead's decision on #85): which host serves this page, and the transport
 * for it.
 *
 * 1. `<meta name="orbitrace-host" content="editor">` selects the webview transport.
 * 2. Otherwise a token `t` in the page fragment selects the HTTP transport. The fragment is
 *    removed from the address bar as soon as it is read.
 * 3. Otherwise the app runs on the bundled demo.
 *
 * Falling back to the demo when a host lists no sessions happens after the first listing, in
 * `Root.tsx`.
 *
 * Each choice also says how an exported replay is saved (issue 168): through the extension in the
 * editor tab (a webview cannot download), as a Blob download in a browser. An editor tab without a
 * host (the extension's demo tab) has neither, so it gets no saver and the app no Export button.
 */

import { createDemoTransport } from "./demo-session";
import { DOWNLOAD_SAVER, type ReplaySaver } from "./export-replay";
import { createHttpTransport, type FetchFunction } from "./http-transport";
import {
  EDITOR_HOST_META_VALUE,
  HOST_META_NAME,
  SESSION_META_NAME,
  readHostFragment,
  transportError,
} from "./protocol";
import type { HostTransport, TransportError } from "./transport";
import {
  createWebviewTransport,
  type MessageEventSource,
  type WebviewApi,
} from "./webview-transport";

/** Which host the page is in, read from the page. The token is held here, never stored. */
export type HostChoice =
  | { readonly kind: "editor"; readonly sessionKey: string | null }
  | { readonly kind: "browser"; readonly token: string; readonly sessionKey: string | null }
  | { readonly kind: "demo" };

/** The parts of the page start-up selection reads and changes. */
export interface StartupPage {
  readonly document: { querySelector(selectors: string): Element | null };
  readonly location: { readonly hash: string; readonly pathname: string; readonly search: string };
  readonly history: {
    readonly state: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
}

/** The transport the app starts with, or why it cannot start. */
export type Startup =
  | {
      readonly kind: "host";
      readonly host: "editor" | "browser";
      readonly transport: HostTransport;
      /** Preselected session, or `null` for the newest one the host lists. */
      readonly sessionKey: string | null;
      /** How an exported replay is saved. Absent: no export. */
      readonly saver?: ReplaySaver;
    }
  | {
      readonly kind: "demo";
      readonly transport: HostTransport;
      /** How an exported replay is saved. Absent: no export. */
      readonly saver?: ReplaySaver;
    }
  | { readonly kind: "failed"; readonly error: TransportError };

export interface StartupDeps {
  /** `acquireVsCodeApi` when the page has it. Called at most once. */
  readonly acquireWebviewApi?: (() => WebviewApi) | undefined;
  /** Where editor messages arrive: `window`. */
  readonly messageEvents: MessageEventSource;
  readonly fetch?: FetchFunction;
  /** Default: the bundled demo. */
  readonly createDemo?: () => HostTransport;
}

export const STARTUP_MESSAGES = {
  noWebviewApi:
    "The editor tab did not provide its message API, so the app cannot reach the editor.",
} as const;

function metaContent(page: StartupPage, name: string): string | null {
  const element = page.document.querySelector(`meta[name="${name}"]`);
  const content = element?.getAttribute("content")?.trim() ?? "";
  return content === "" ? null : content;
}

/**
 * Read the page and decide on a host. When the fragment carries a token or a session key, it is
 * removed from the address bar (with `history.replaceState`) before this returns.
 */
export function chooseHost(page: StartupPage): HostChoice {
  if (metaContent(page, HOST_META_NAME) === EDITOR_HOST_META_VALUE) {
    return { kind: "editor", sessionKey: metaContent(page, SESSION_META_NAME) };
  }
  const fragment = readHostFragment(page.location.hash);
  if (fragment.token !== null || fragment.sessionKey !== null) {
    page.history.replaceState(
      page.history.state,
      "",
      page.location.pathname + page.location.search,
    );
  }
  if (fragment.token !== null) {
    return { kind: "browser", token: fragment.token, sessionKey: fragment.sessionKey };
  }
  return { kind: "demo" };
}

/** Build the transport for a host choice. */
export function createStartup(choice: HostChoice, deps: StartupDeps): Startup {
  switch (choice.kind) {
    case "editor": {
      if (deps.acquireWebviewApi === undefined) {
        return {
          kind: "failed",
          error: transportError("unsupported", STARTUP_MESSAGES.noWebviewApi),
        };
      }
      const transport = createWebviewTransport({
        api: deps.acquireWebviewApi(),
        events: deps.messageEvents,
      });
      const saver: ReplaySaver = {
        kind: "save",
        save: (file) => transport.saveReplay(file.data),
      };
      return { kind: "host", host: "editor", transport, sessionKey: choice.sessionKey, saver };
    }
    case "browser": {
      const transport = createHttpTransport({
        token: choice.token,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      });
      return {
        kind: "host",
        host: "browser",
        transport,
        sessionKey: choice.sessionKey,
        saver: DOWNLOAD_SAVER,
      };
    }
    case "demo": {
      const transport = (deps.createDemo ?? createDemoTransport)();
      // A page with the editor's message API but no host tag is an editor tab with no host: it
      // can neither download nor ask the extension to save.
      return deps.acquireWebviewApi === undefined
        ? { kind: "demo", transport, saver: DOWNLOAD_SAVER }
        : { kind: "demo", transport };
    }
  }
}

/** The page globals `startupFromPage` reads: `window` in the browser. */
export type StartupWindow = StartupPage &
  MessageEventSource & {
    /** Provided by the editor in its webview. Callable once per page. */
    readonly acquireVsCodeApi?: (() => WebviewApi) | undefined;
  };

/** Start-up selection for a page: `chooseHost`, then `createStartup` with the page's globals. */
export function startupFromPage(page: StartupWindow): Startup {
  const acquire = page.acquireVsCodeApi;
  return createStartup(chooseHost(page), {
    acquireWebviewApi: typeof acquire === "function" ? () => acquire() : undefined,
    messageEvents: page,
  });
}
