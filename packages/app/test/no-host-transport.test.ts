import { describe, expect, it, vi } from "vitest";
import { DEMO_SESSION_KEY, DEMO_SUMMARY, createDemoTransport } from "../src/demo-session";
import {
  NO_HOST_MESSAGES,
  createNoHostTransport,
  isTransportError,
  transportError,
} from "../src/no-host-transport";
import type { LiveUpdate } from "../src/transport";
import { DEMO, SUMMARY, makeModel } from "./helpers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("transport errors", () => {
  it("builds and recognises the { code, message } shape", () => {
    expect(transportError("not-found", "x")).toEqual({ code: "not-found", message: "x" });
    expect(isTransportError({ code: "internal", message: "m" })).toBe(true);
    expect(isTransportError(new Error("x"))).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("internal")).toBe(false);
  });
});

describe("createNoHostTransport", () => {
  const second = { ...SUMMARY, key: "session-2", lastActivity: 5 };

  it("is a browser host that cannot open a browser", async () => {
    const transport = createNoHostTransport([]);
    expect(transport.kind).toBe("browser");
    expect(transport.canOpenInBrowser).toBe(false);
    await expect(transport.openInBrowser()).rejects.toEqual({
      code: "unsupported",
      message: NO_HOST_MESSAGES.unsupported,
    });
  });

  it("lists sessions with since and limit", async () => {
    const transport = createNoHostTransport([
      { summary: SUMMARY, load: async () => makeModel() },
      { summary: second, load: async () => makeModel() },
    ]);
    expect(await transport.listSessions()).toEqual([SUMMARY, second]);
    expect(await transport.listSessions({ limit: 1 })).toEqual([SUMMARY]);
    expect(await transport.listSessions({ since: 2 })).toEqual([second]);
    expect(await transport.listSessions({ limit: -1 })).toEqual([]);
  });

  it("loads a valid replay once and caches it", async () => {
    const load = vi.fn(async () => makeModel());
    const transport = createNoHostTransport([{ summary: SUMMARY, load }]);
    const first = await transport.loadReplay(SUMMARY.key);
    expect(first.agents).toHaveLength(3);
    expect(await transport.loadReplay(SUMMARY.key)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown key, an invalid replay and a failed load", async () => {
    const transport = createNoHostTransport([
      { summary: SUMMARY, load: async () => ({ formatVersion: 9 }) },
      { summary: second, load: () => Promise.reject(new Error("synthetic")) },
    ]);
    await expect(transport.loadReplay("missing")).rejects.toEqual({
      code: "not-found",
      message: NO_HOST_MESSAGES.notFound,
    });
    await expect(transport.loadReplay(SUMMARY.key)).rejects.toMatchObject({ code: "invalid" });
    await expect(transport.loadReplay(second.key)).rejects.toEqual({
      code: "unreadable",
      message: NO_HOST_MESSAGES.unreadable,
    });
  });

  it("retries a load that failed", async () => {
    let calls = 0;
    const transport = createNoHostTransport([
      {
        summary: SUMMARY,
        load: async () => {
          calls += 1;
          if (calls === 1) throw new Error("synthetic");
          return makeModel();
        },
      },
    ]);
    await expect(transport.loadReplay(SUMMARY.key)).rejects.toMatchObject({ code: "unreadable" });
    await flush();
    await expect(transport.loadReplay(SUMMARY.key)).resolves.toBeDefined();
  });

  it("subscribe sends the replay, then ended", async () => {
    const transport = createNoHostTransport([{ summary: SUMMARY, load: async () => makeModel() }]);
    const updates: LiveUpdate[] = [];
    transport.subscribe(SUMMARY.key, (update) => updates.push(update));
    await flush();
    expect(updates.map((u) => u.type)).toEqual(["replay", "ended"]);
    expect(updates[0]).toMatchObject({ type: "replay", live: "ended" });
  });

  it("subscribe sends an error for an unknown key", async () => {
    const transport = createNoHostTransport([]);
    const updates: LiveUpdate[] = [];
    transport.subscribe("missing", (update) => updates.push(update));
    await flush();
    expect(updates).toEqual([
      { type: "error", error: { code: "not-found", message: NO_HOST_MESSAGES.notFound } },
    ]);
  });

  it("sends nothing after unsubscribe", async () => {
    const transport = createNoHostTransport([{ summary: SUMMARY, load: async () => makeModel() }]);
    const listener = vi.fn();
    const stop = transport.subscribe(SUMMARY.key, listener);
    stop();
    stop();
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops after the replay when unsubscribed from inside the listener", async () => {
    const transport = createNoHostTransport([{ summary: SUMMARY, load: async () => makeModel() }]);
    const updates: string[] = [];
    const stop = transport.subscribe(SUMMARY.key, (update) => {
      updates.push(update.type);
      stop();
    });
    await flush();
    expect(updates).toEqual(["replay"]);
  });
});

describe("demo transport", () => {
  it("lists the demo and serves the validated golden replay", async () => {
    const transport = createDemoTransport();
    expect(await transport.listSessions()).toEqual([DEMO_SUMMARY]);
    const model = await transport.loadReplay(DEMO_SESSION_KEY);
    expect(model).toEqual(DEMO);
    expect(DEMO_SUMMARY.subagentCount).toBe(model.agents.length - 1);
  });
});
