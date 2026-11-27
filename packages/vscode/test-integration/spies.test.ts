import { describe, expect, it } from "vitest";
import {
  installApiSpies,
  liveMessages,
  recordPanel,
  recordTree,
  repliesTo,
  webviewRequests,
  type DisposableLike,
  type EventLike,
  type PanelLike,
  type TreeProviderLike,
  type WindowLike,
} from "./spies.js";

/** A minimal event emitter in the shape of `vscode.Event`. */
function emitter<T>(): { event: EventLike<T>; fire(value: T): void; count(): number } {
  const listeners = new Set<(value: T) => unknown>();
  return {
    event: (listener, thisArgs) => {
      const bound = (value: T): unknown => listener.call(thisArgs, value);
      listeners.add(bound);
      return { dispose: () => listeners.delete(bound) };
    },
    fire: (value) => {
      for (const listener of [...listeners]) listener(value);
    },
    count: () => listeners.size,
  };
}

interface FakePanel extends PanelLike {
  readonly sent: unknown[];
  receive(message: unknown): void;
  dispose(): void;
  receiverCount(): number;
}

/** A fake webview panel: `receive` is the webview posting, `sent` what reached it. */
function fakePanel(title = "Orbitrace"): FakePanel {
  const received = emitter<unknown>();
  const disposed = emitter<void>();
  const sent: unknown[] = [];
  return {
    title,
    webview: {
      html: "",
      cspSource: "'self'",
      postMessage(message: unknown) {
        sent.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: received.event,
    },
    onDidDispose: disposed.event,
    sent,
    receive: (message) => received.fire(message),
    dispose: () => disposed.fire(),
    receiverCount: () => received.count(),
  };
}

describe("recordPanel", () => {
  it("records messages from the webview and passes them to the extension's handler", () => {
    const panel = fakePanel();
    const record = recordPanel(panel, "orbitrace.visualizer");
    const seen: unknown[] = [];
    panel.webview.onDidReceiveMessage((message) => seen.push(message));
    expect(record.handlerCount).toBe(1);
    panel.receive({ id: 1, method: "listSessions", params: {} });
    expect(seen).toEqual([{ id: 1, method: "listSessions", params: {} }]);
    expect(record.received).toEqual([
      { from: "webview", message: { id: 1, method: "listSessions", params: {} } },
    ]);
    expect(record.viewType).toBe("orbitrace.visualizer");
  });

  it("hands injected messages to the handlers, marked as from the test", () => {
    const panel = fakePanel();
    const record = recordPanel(panel, "t");
    const seen: unknown[] = [];
    panel.webview.onDidReceiveMessage((message) => seen.push(message));
    record.inject("hello");
    expect(seen).toEqual(["hello"]);
    expect(record.received).toEqual([{ from: "test", message: "hello" }]);
  });

  it("keeps the handler's this argument and its disposables list", () => {
    const panel = fakePanel();
    recordPanel(panel, "t");
    const owner = { seen: [] as unknown[] };
    const disposables: DisposableLike[] = [];
    panel.webview.onDidReceiveMessage(
      function (this: typeof owner, message) {
        this.seen.push(message);
      },
      owner,
      disposables,
    );
    panel.receive(1);
    expect(owner.seen).toEqual([1]);
  });

  it("forgets a handler once its subscription is disposed", () => {
    const panel = fakePanel();
    const record = recordPanel(panel, "t");
    const subscription = panel.webview.onDidReceiveMessage(() => undefined);
    subscription.dispose();
    expect(record.handlerCount).toBe(0);
    expect(panel.receiverCount()).toBe(0);
  });

  it("records posts, also after the panel was disposed, and still delivers them", async () => {
    const panel = fakePanel();
    const record = recordPanel(panel, "t");
    await panel.webview.postMessage({ kind: "result", id: 1, result: null });
    expect(record.disposed).toBe(false);
    panel.dispose();
    expect(record.disposed).toBe(true);
    await panel.webview.postMessage({ kind: "result", id: 2, result: null });
    expect(record.posted.map((entry) => entry.afterDispose)).toEqual([false, true]);
    expect(panel.sent).toHaveLength(2);
  });
});

describe("recordTree", () => {
  it("records each top-level listing and nothing for child listings or failures", async () => {
    let fail = false;
    const provider: TreeProviderLike = {
      getChildren(element?: unknown) {
        if (fail) return Promise.reject(new Error("no"));
        return Promise.resolve(element === undefined ? ["a", "b"] : ["child"]);
      },
      getTreeItem: (element) => element,
    };
    const record = recordTree("orbitrace.sessions", provider, undefined);
    expect(await provider.getChildren()).toEqual(["a", "b"]);
    expect(await provider.getChildren("a")).toEqual(["child"]);
    fail = true;
    await expect(provider.getChildren()).rejects.toThrow("no");
    await Promise.resolve();
    expect(record.loads).toEqual([{ nodes: ["a", "b"] }]);
    expect(record.viewId).toBe("orbitrace.sessions");
  });

  it("records a synchronous non-list result as an empty listing", async () => {
    const provider: TreeProviderLike = { getChildren: () => undefined, getTreeItem: (e) => e };
    const record = recordTree("v", provider, undefined);
    provider.getChildren();
    await Promise.resolve();
    await Promise.resolve();
    expect(record.loads).toEqual([{ nodes: [] }]);
  });
});

describe("installApiSpies", () => {
  function fakeWindow(): WindowLike & { panels: FakePanel[] } {
    const panels: FakePanel[] = [];
    return {
      panels,
      createWebviewPanel(...args: never[]) {
        const panel = fakePanel(String(args[1]));
        panels.push(panel);
        return panel;
      },
      createTreeView(viewId: string, options: { treeDataProvider: TreeProviderLike }) {
        return { viewId, provider: options.treeDataProvider };
      },
    };
  }

  it("records every panel and tree view created after it is installed", async () => {
    const window = fakeWindow();
    const spies = installApiSpies(window);
    const create = window.createWebviewPanel as unknown as (...args: unknown[]) => FakePanel;
    const panel = create("orbitrace.visualizer", "Title");
    expect(panel).toBe(window.panels[0]);
    expect(spies.panels).toHaveLength(1);
    expect(spies.panels[0]?.viewType).toBe("orbitrace.visualizer");

    const provider: TreeProviderLike = {
      getChildren: () => Promise.resolve(["row"]),
      getTreeItem: (e) => e,
    };
    const view = window.createTreeView("orbitrace.sessions", { treeDataProvider: provider });
    expect(view).toEqual({ viewId: "orbitrace.sessions", provider });
    await provider.getChildren();
    await Promise.resolve();
    expect(spies.trees[0]?.view).toBe(view);
    expect(spies.trees[0]?.loads).toEqual([{ nodes: ["row"] }]);
  });

  it("puts the original functions back", () => {
    const window = fakeWindow();
    const originalPanel = window.createWebviewPanel;
    const originalTree = window.createTreeView;
    const spies = installApiSpies(window);
    expect(window.createWebviewPanel).not.toBe(originalPanel);
    spies.restore();
    expect(window.createWebviewPanel).toBe(originalPanel);
    expect(window.createTreeView).toBe(originalTree);
  });

  it("throws when the namespace cannot be changed", () => {
    const frozen = Object.freeze(fakeWindow());
    expect(() => installApiSpies(frozen)).toThrow();
  });
});

describe("message filters", () => {
  const replay = { schemaVersion: 1 };
  const posted = [
    { message: { kind: "result", id: 1, result: [] }, afterDispose: false },
    { message: { kind: "error", id: 2, error: { code: "x", message: "y" } }, afterDispose: false },
    {
      message: {
        kind: "live",
        subscriptionId: 3,
        key: "k",
        update: { type: "replay", replay, live: "live" },
      },
      afterDispose: false,
    },
    {
      message: { kind: "live", subscriptionId: 4, key: "k", update: { type: "ended" } },
      afterDispose: false,
    },
    { message: "not an object", afterDispose: false },
    { message: null, afterDispose: false },
  ];

  it("repliesTo finds results and errors by request id", () => {
    expect(repliesTo({ posted }, 1)).toEqual([posted[0]?.message]);
    expect(repliesTo({ posted }, 2)).toEqual([posted[1]?.message]);
    expect(repliesTo({ posted }, 3)).toEqual([]);
  });

  it("repliesTo leaves out replies that are not valid transport messages", () => {
    const malformed = [
      // An error without a message.
      { message: { kind: "error", id: 7, error: { code: "x" } }, afterDispose: false },
      // A result whose id is not a request id.
      { message: { kind: "result", id: -1, result: null }, afterDispose: false },
      { message: { kind: "result", id: "7", result: null }, afterDispose: false },
      // An unknown kind.
      { message: { kind: "reply", id: 7, result: null }, afterDispose: false },
    ];
    expect(repliesTo({ posted: malformed }, 7)).toEqual([]);
    expect(repliesTo({ posted: malformed }, -1)).toEqual([]);
  });

  it("repliesTo returns core's copy of the message, without extra fields", () => {
    const extra = [
      { message: { kind: "result", id: 8, result: 1, path: "/somewhere" }, afterDispose: false },
    ];
    expect(repliesTo({ posted: extra }, 8)).toEqual([{ kind: "result", id: 8, result: 1 }]);
  });

  it("liveMessages finds live updates by subscription id", () => {
    expect(liveMessages({ posted }, 3)).toEqual([posted[2]?.message]);
    expect(liveMessages({ posted }, 4)).toEqual([posted[3]?.message]);
    expect(liveMessages({ posted }, 1)).toEqual([]);
  });

  it("liveMessages leaves out live messages with a malformed update", () => {
    const malformed = [
      { message: { kind: "live", subscriptionId: 5, key: "k", update: {} }, afterDispose: false },
      {
        message: { kind: "live", subscriptionId: 5, key: "k", update: { type: "replay" } },
        afterDispose: false,
      },
      {
        message: { kind: "live", subscriptionId: 5, key: "k", update: { type: "error" } },
        afterDispose: false,
      },
      {
        message: { kind: "live", subscriptionId: 5, update: { type: "ended" } },
        afterDispose: false,
      },
    ];
    expect(liveMessages({ posted: malformed }, 5)).toEqual([]);
  });

  it("webviewRequests keeps only valid requests the webview itself sent with one method", () => {
    const received = [
      { from: "webview" as const, message: { id: 1, method: "listSessions", params: {} } },
      { from: "test" as const, message: { id: 2, method: "listSessions", params: {} } },
      { from: "webview" as const, message: { id: 3, method: "loadReplay", params: { key: "k" } } },
      { from: "webview" as const, message: { id: "4", method: "listSessions" } },
      // A known method with no params is not a request.
      { from: "webview" as const, message: { id: 6, method: "listSessions" } },
      { from: "webview" as const, message: 5 },
    ];
    expect(webviewRequests({ received }, "listSessions")).toEqual([received[0]?.message]);
    const loads = webviewRequests({ received }, "loadReplay");
    expect(loads).toEqual([received[2]?.message]);
    expect(loads[0]?.params.key).toBe("k");
  });

  it("webviewRequests keeps only the known fields of a request", () => {
    const received = [
      {
        from: "webview" as const,
        message: { id: 1, method: "subscribe", params: { key: "k", extra: true }, more: 1 },
      },
    ];
    expect(webviewRequests({ received }, "subscribe")).toEqual([
      { id: 1, method: "subscribe", params: { key: "k" } },
    ]);
  });
});
