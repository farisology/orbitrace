import { describe, expect, it, vi } from "vitest";
import { CLIENT_MESSAGES } from "../src/client-decode";
import type { LiveUpdate } from "../src/transport";
import { WEBVIEW_MESSAGES, createWebviewTransport } from "../src/webview-transport";
import { SUMMARY, makeModel } from "./helpers";
import { fakeWebview, settle } from "./fake-hosts";

function setup() {
  const webview = fakeWebview();
  const transport = createWebviewTransport({ api: webview.api, events: webview.events });
  return { webview, transport };
}

describe("webview transport", () => {
  it("is the editor host and can open in a browser", () => {
    const { transport } = setup();
    expect(transport.kind).toBe("editor");
    expect(transport.canOpenInBrowser).toBe(true);
  });

  it("sends requests with unique ids and settles each by its id", async () => {
    const { webview, transport } = setup();
    const listing = transport.listSessions({ limit: 5 });
    const loading = transport.loadReplay("session-1");
    expect(webview.posted).toEqual([
      { id: 1, method: "listSessions", params: { options: { limit: 5 } } },
      { id: 2, method: "loadReplay", params: { key: "session-1" } },
    ]);
    // Replies out of order still reach the right request.
    webview.reply({ kind: "result", id: 2, result: makeModel() });
    webview.reply({ kind: "result", id: 1, result: [SUMMARY] });
    await expect(listing).resolves.toEqual([SUMMARY]);
    await expect(loading).resolves.toEqual(makeModel());
  });

  it("rejects with the host's error", async () => {
    const { webview, transport } = setup();
    const loading = transport.loadReplay("missing");
    webview.reply({
      kind: "error",
      id: 1,
      error: { code: "not-found", message: "No session with that key." },
    });
    await expect(loading).rejects.toEqual({
      code: "not-found",
      message: "No session with that key.",
    });
  });

  it("rejects a replay that does not validate and a session list that is not a list", async () => {
    const { webview, transport } = setup();
    const loading = transport.loadReplay("session-1");
    const listing = transport.listSessions();
    webview.reply({ kind: "result", id: 1, result: { formatVersion: 99 } });
    webview.reply({ kind: "result", id: 2, result: "nope" });
    await expect(loading).rejects.toMatchObject({ code: "invalid" });
    await expect(listing).rejects.toEqual({
      code: "invalid",
      message: CLIENT_MESSAGES.badSessions,
    });
  });

  it("ignores messages that are not transport messages or answer nothing pending", async () => {
    const { webview, transport } = setup();
    const listing = transport.listSessions();
    webview.reply("hello");
    webview.reply({ kind: "result", id: 99, result: [] });
    webview.reply({ kind: "live", subscriptionId: 42, key: "x", update: { type: "ended" } });
    webview.reply({ kind: "result", id: 1, result: [] });
    await expect(listing).resolves.toEqual([]);
  });

  it("routes live updates by subscription id, not by session key", async () => {
    const { webview, transport } = setup();
    const first: LiveUpdate[] = [];
    const second: LiveUpdate[] = [];
    transport.subscribe("session-1", (update) => first.push(update));
    transport.subscribe("session-1", (update) => second.push(update));
    expect(webview.posted).toEqual([
      { id: 1, method: "subscribe", params: { key: "session-1" } },
      { id: 2, method: "subscribe", params: { key: "session-1" } },
    ]);
    webview.reply({ kind: "result", id: 1, result: null });
    webview.reply({
      kind: "live",
      subscriptionId: 2,
      key: "session-1",
      update: { type: "replay", replay: makeModel(10), live: "busy" },
    });
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "replay", replay: makeModel(10), live: "busy" }]);
    webview.reply({ kind: "live", subscriptionId: 1, key: "session-1", update: { type: "ended" } });
    expect(first).toEqual([{ type: "ended" }]);
    // Ended: later messages for it are dropped.
    webview.reply({
      kind: "live",
      subscriptionId: 1,
      key: "session-1",
      update: { type: "replay", replay: makeModel(), live: "busy" },
    });
    expect(first).toHaveLength(1);
  });

  it("unsubscribes one subscription on the host and stops delivering to it", async () => {
    const { webview, transport } = setup();
    const updates: LiveUpdate[] = [];
    const stop = transport.subscribe("session-1", (update) => updates.push(update));
    stop();
    stop();
    expect(webview.posted).toEqual([
      { id: 1, method: "subscribe", params: { key: "session-1" } },
      { id: 2, method: "unsubscribe", params: { subscriptionId: 1 } },
    ]);
    webview.reply({ kind: "result", id: 2, result: null });
    webview.reply({
      kind: "live",
      subscriptionId: 1,
      key: "session-1",
      update: { type: "replay", replay: makeModel(), live: "busy" },
    });
    expect(updates).toEqual([]);
  });

  it("ends a subscription the host refuses with an error update", async () => {
    const { webview, transport } = setup();
    const listener = vi.fn();
    transport.subscribe("missing", listener);
    webview.reply({ kind: "error", id: 1, error: { code: "not-found", message: "Gone." } });
    expect(listener).toHaveBeenCalledWith({
      type: "error",
      error: { code: "not-found", message: "Gone." },
    });
  });

  it("turns an invalid live replay into an error and tells the host to stop", async () => {
    const { webview, transport } = setup();
    const listener = vi.fn();
    transport.subscribe("session-1", listener);
    webview.reply({
      kind: "live",
      subscriptionId: 1,
      key: "session-1",
      update: { type: "replay", replay: { formatVersion: 99 }, live: "busy" },
    });
    expect(listener).toHaveBeenCalledWith({
      type: "error",
      error: expect.objectContaining({ code: "invalid" }),
    });
    expect(webview.posted.at(-1)).toEqual({
      id: 2,
      method: "unsubscribe",
      params: { subscriptionId: 1 },
    });
  });

  it("forwards openInBrowser with and without a key", async () => {
    const { webview, transport } = setup();
    const withKey = transport.openInBrowser("session-1");
    const withoutKey = transport.openInBrowser();
    webview.reply({ kind: "result", id: 1, result: null });
    webview.reply({ kind: "result", id: 2, result: null });
    await expect(withKey).resolves.toBeUndefined();
    await expect(withoutKey).resolves.toBeUndefined();
    expect(webview.posted.map((r) => r.params)).toEqual([{ key: "session-1" }, {}]);
  });

  it("rejects every pending request and ends subscriptions when posting fails", async () => {
    const { webview, transport } = setup();
    const listing = transport.listSessions();
    const listener = vi.fn();
    transport.subscribe("session-1", listener);
    webview.breakChannel();
    const loading = transport.loadReplay("session-1");
    const failure = { code: "internal", message: WEBVIEW_MESSAGES.sendFailed };
    await expect(loading).rejects.toEqual(failure);
    await expect(listing).rejects.toEqual(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "error", error: failure });
    // Closed for good: later calls fail at once, without posting.
    await expect(transport.listSessions()).rejects.toEqual(failure);
    const late = vi.fn();
    transport.subscribe("session-2", late);
    await settle(1);
    expect(late).toHaveBeenCalledWith({ type: "error", error: failure });
    expect(webview.listenerCount()).toBe(0);
  });

  it("rejects pending requests when a message cannot be read, and keeps working", async () => {
    const { webview, transport } = setup();
    const listing = transport.listSessions();
    const listener = vi.fn();
    transport.subscribe("session-1", listener);
    webview.messageError();
    const failure = { code: "internal", message: WEBVIEW_MESSAGES.unreadable };
    await expect(listing).rejects.toEqual(failure);
    expect(listener).toHaveBeenCalledWith({ type: "error", error: failure });
    const again = transport.listSessions();
    webview.reply({ kind: "result", id: 3, result: [] });
    await expect(again).resolves.toEqual([]);
  });

  it("close rejects pending requests and stops listening", async () => {
    const { webview, transport } = setup();
    const listing = transport.listSessions();
    transport.close();
    transport.close();
    await expect(listing).rejects.toEqual({ code: "internal", message: WEBVIEW_MESSAGES.closed });
    expect(webview.listenerCount()).toBe(0);
  });
});
