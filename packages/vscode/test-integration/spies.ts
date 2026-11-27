/**
 * Watches what the extension does with the editor API, without changing the extension.
 *
 * The extension exports no test API: its panels and its tree provider live inside its own
 * module. But the extension host hands one `vscode` API object to every module loaded from an
 * extension's folder, and the suite bundle is loaded from this package's folder. So the suite
 * can wrap `window.createWebviewPanel` and `window.createTreeView` on that shared object before
 * the extension activates, and keep a record of every panel and tree view it creates:
 *
 * - a panel's HTML (`webview.html`), every message the webview sent to it, and every message
 *   the extension posted to the webview (also those attempted after the panel was disposed);
 * - the extension's handlers for webview messages, so the suite can also hand them a message
 *   directly, the way the webview would;
 * - every top-level listing the Sessions view asked its provider for.
 *
 * If the extension host ever stops sharing the API object, the suite sees no panel or tree
 * view and fails with a message that says so.
 *
 * The wrappers call the originals with the same arguments and return what they return. Only
 * structural types are used for the editor API, so the module is unit tested with fakes
 * (`spies.test.ts`). Messages are read with core's protocol checks, never with local copies of
 * the transport types.
 */

import {
  parseTransportMessage,
  parseTransportRequest,
  type TransportMessage,
  type TransportMethod,
  type TransportRequest,
} from "@orbitrace/core";

/** The part of `vscode.Disposable` used here. */
export interface DisposableLike {
  dispose(): unknown;
}

/** `vscode.Event<T>`. */
export type EventLike<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: DisposableLike[],
) => DisposableLike;

/** The part of `vscode.Webview` used here. */
export interface WebviewLike {
  html: string;
  readonly cspSource: string;
  postMessage(message: unknown): PromiseLike<boolean> | boolean;
  readonly onDidReceiveMessage: EventLike<unknown>;
}

/** The part of `vscode.WebviewPanel` used here. */
export interface PanelLike {
  readonly title: string;
  readonly webview: WebviewLike;
  readonly onDidDispose: EventLike<void>;
}

/** The part of `vscode.TreeDataProvider` used here. */
export interface TreeProviderLike {
  getChildren(element?: unknown): unknown;
  getTreeItem(element: unknown): unknown;
}

/** The part of `vscode.window` used here. */
export interface WindowLike {
  createWebviewPanel(...args: never[]): unknown;
  createTreeView(viewId: string, options: { treeDataProvider: TreeProviderLike }): unknown;
}

/** A message the webview sent (`webview`) or the suite handed to the handlers (`test`). */
export interface ReceivedMessage {
  readonly from: "webview" | "test";
  readonly message: unknown;
}

/** A message the extension posted to the webview. */
export interface PostedMessage {
  readonly message: unknown;
  /** True when the panel was already disposed when the extension tried to post. */
  readonly afterDispose: boolean;
}

export interface PanelRecord {
  readonly panel: PanelLike;
  /** The view type the extension asked for. */
  readonly viewType: string;
  readonly received: ReceivedMessage[];
  readonly posted: PostedMessage[];
  /** How many message handlers the extension registered on this panel. */
  readonly handlerCount: number;
  readonly disposed: boolean;
  /** Hand a message to the extension's handlers, as if the webview had sent it. */
  inject(message: unknown): void;
}

export interface TreeLoad {
  /** The top-level nodes the provider returned. */
  readonly nodes: readonly unknown[];
}

export interface TreeRecord {
  readonly viewId: string;
  readonly provider: TreeProviderLike;
  /** What `createTreeView` returned. */
  readonly view: unknown;
  /** Every top-level listing, oldest first. A failed listing is not recorded. */
  readonly loads: TreeLoad[];
}

export interface ApiSpies {
  readonly panels: PanelRecord[];
  readonly trees: TreeRecord[];
  /** Put the original functions back. */
  restore(): void;
}

/** Replace a property with a value, whether it is a field or an accessor. */
function override(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, configurable: true, writable: true });
}

/** Wrap one panel's webview so its traffic is recorded. */
export function recordPanel(panel: PanelLike, viewType: string): PanelRecord {
  const webview = panel.webview;
  const originalEvent = webview.onDidReceiveMessage;
  const originalPost = webview.postMessage;
  const handlers: ((message: unknown) => unknown)[] = [];
  const state = { disposed: false };
  const record: PanelRecord = {
    panel,
    viewType,
    received: [],
    posted: [],
    get handlerCount() {
      return handlers.length;
    },
    get disposed() {
      return state.disposed;
    },
    inject(message: unknown): void {
      record.received.push({ from: "test", message });
      for (const handler of [...handlers]) handler(message);
    },
  };
  const onDidReceiveMessage: EventLike<unknown> = (listener, thisArgs, disposables) => {
    const handler = (message: unknown): unknown => listener.call(thisArgs, message);
    handlers.push(handler);
    const subscription = originalEvent.call(
      webview,
      (message: unknown) => {
        record.received.push({ from: "webview", message });
        return handler(message);
      },
      undefined,
      disposables,
    );
    return {
      dispose(): unknown {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
        return subscription.dispose();
      },
    };
  };
  override(webview, "onDidReceiveMessage", onDidReceiveMessage);
  override(webview, "postMessage", (message: unknown) => {
    record.posted.push({ message, afterDispose: state.disposed });
    return originalPost.call(webview, message);
  });
  panel.onDidDispose(() => {
    state.disposed = true;
  });
  return record;
}

/** Wrap a tree data provider so each top-level listing is recorded. */
export function recordTree(viewId: string, provider: TreeProviderLike, view: unknown): TreeRecord {
  const record: TreeRecord = { viewId, provider, view, loads: [] };
  const original = provider.getChildren;
  override(provider, "getChildren", function (this: unknown, element?: unknown) {
    const result = original.call(provider, element);
    if (element === undefined) {
      void Promise.resolve(result).then(
        (nodes) => {
          record.loads.push({ nodes: Array.isArray(nodes) ? [...(nodes as unknown[])] : [] });
        },
        () => undefined,
      );
    }
    return result;
  });
  return record;
}

/**
 * Start recording on a `vscode.window` namespace. Throws when the namespace cannot be
 * changed. Call before the extension activates.
 */
export function installApiSpies(window: WindowLike): ApiSpies {
  const panels: PanelRecord[] = [];
  const trees: TreeRecord[] = [];
  const originalPanel = window.createWebviewPanel;
  const originalTree = window.createTreeView;
  override(window, "createWebviewPanel", (...args: unknown[]) => {
    const panel = (originalPanel as (...a: unknown[]) => PanelLike).apply(window, args);
    panels.push(recordPanel(panel, String(args[0])));
    return panel;
  });
  override(
    window,
    "createTreeView",
    (viewId: string, options: { treeDataProvider: TreeProviderLike }) => {
      // Wrap before the view exists, so its first listing is seen too.
      const record = recordTree(viewId, options.treeDataProvider, undefined);
      const view = originalTree.call(window, viewId, options);
      trees.push({ ...record, view });
      return view;
    },
  );
  if (window.createWebviewPanel === originalPanel || window.createTreeView === originalTree) {
    throw new Error("the editor API namespace could not be wrapped");
  }
  return {
    panels,
    trees,
    restore(): void {
      override(window, "createWebviewPanel", originalPanel);
      override(window, "createTreeView", originalTree);
    },
  };
}

/** A reply to a request: what the host posts back for one `id`. */
export type TransportReply = Extract<TransportMessage, { kind: "result" | "error" }>;

/** A pushed live update for one subscription. */
export type TransportLiveMessage = Extract<TransportMessage, { kind: "live" }>;

/** The request of method `M`. */
export type RequestOf<M extends TransportMethod> = Extract<TransportRequest, { method: M }>;

/**
 * Every message the extension posted, read with core's `parseTransportMessage`. A posted value
 * that is not a valid `TransportMessage` (wrong kind, an error without `message`, a live
 * message with a malformed `update`) is left out, so the filters below never match it and the
 * suite's wait for a reply fails instead of passing on a malformed one.
 */
function postedMessages(record: Pick<PanelRecord, "posted">): TransportMessage[] {
  return record.posted
    .map((entry) => parseTransportMessage(entry.message))
    .filter((message): message is TransportMessage => message !== null);
}

/** The messages the extension posted in reply to request `id` (`result` or `error`). */
export function repliesTo(record: Pick<PanelRecord, "posted">, id: number): TransportReply[] {
  return postedMessages(record).filter(
    (message): message is TransportReply =>
      (message.kind === "result" || message.kind === "error") && message.id === id,
  );
}

/** The `live` messages the extension posted for subscription `id`. */
export function liveMessages(
  record: Pick<PanelRecord, "posted">,
  id: number,
): TransportLiveMessage[] {
  return postedMessages(record).filter(
    (message): message is TransportLiveMessage =>
      message.kind === "live" && message.subscriptionId === id,
  );
}

/**
 * The valid requests the webview itself sent with method `method`, read with core's
 * `parseTransportRequest` (so only the known fields are kept).
 */
export function webviewRequests<M extends TransportMethod>(
  record: Pick<PanelRecord, "received">,
  method: M,
): RequestOf<M>[] {
  return record.received
    .filter((entry) => entry.from === "webview")
    .map((entry) => parseTransportRequest(entry.message))
    .filter((request): request is RequestOf<M> => request !== null && request.method === method);
}
