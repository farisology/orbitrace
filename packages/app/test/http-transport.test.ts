import { ReadableStream } from "node:stream/web";
import { describe, expect, it, vi } from "vitest";
import { HTTP_MESSAGES, createHttpTransport, readLines, statusError } from "../src/http-transport";
import type { LiveUpdate } from "../src/transport";
import { SUMMARY, makeModel } from "./helpers";
import { fakeFetch, settle } from "./fake-hosts";

const TOKEN = "synthetic-token-0123456789abcdef0123456789abcdef";

function setup() {
  const server = fakeFetch();
  const transport = createHttpTransport({ token: TOKEN, fetch: server.fetch });
  return { server, transport };
}

describe("HTTP transport requests", () => {
  it("is the browser host without openInBrowser", () => {
    const { transport } = setup();
    expect(transport.kind).toBe("browser");
    expect(transport.canOpenInBrowser).toBe(false);
  });

  it("posts each request to /api/rpc with the bearer token and no cookies", async () => {
    const { server, transport } = setup();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: [SUMMARY] });
    await expect(transport.listSessions({ since: 5 })).resolves.toEqual([SUMMARY]);
    const call = server.calls[0];
    expect(call?.url).toBe("/api/rpc");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.referrerPolicy).toBe("no-referrer");
    expect(call?.body).toEqual({
      id: 1,
      method: "listSessions",
      params: { options: { since: 5 } },
    });
  });

  it("never puts the token in a URL or a body", async () => {
    const { server, transport } = setup();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: makeModel() });
    await transport.loadReplay("session-1");
    transport.subscribe("session-1", () => {})();
    for (const call of server.calls) {
      expect(call.url).not.toContain(TOKEN);
      expect(call.url.startsWith("/")).toBe(true);
      expect(JSON.stringify(call.body)).not.toContain(TOKEN);
    }
  });

  it("loads and validates a replay", async () => {
    const { server, transport } = setup();
    server.rpc = (request) => ({ kind: "result", id: request.id, result: makeModel() });
    await expect(transport.loadReplay("session-1")).resolves.toEqual(makeModel());
    server.rpc = (request) => ({ kind: "result", id: request.id, result: { formatVersion: 2 } });
    await expect(transport.loadReplay("session-1")).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects with the server's error message", async () => {
    const { server, transport } = setup();
    server.rpc = (request) => ({
      status: 404,
      body: { kind: "error", id: request.id, error: { code: "not-found", message: "No session." } },
    });
    await expect(transport.loadReplay("missing")).rejects.toEqual({
      code: "not-found",
      message: "No session.",
    });
  });

  it("reports a refused token as unauthorized, with a fixed message", async () => {
    const { server, transport } = setup();
    server.rpc = () => ({ status: 401, body: "denied" });
    const error = await transport.listSessions().catch((e: unknown) => e);
    expect(error).toEqual({ code: "unauthorized", message: HTTP_MESSAGES.refused });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("reports a network failure, a bad status and an unreadable reply", async () => {
    const { server, transport } = setup();
    server.offline = true;
    await expect(transport.listSessions()).rejects.toEqual({
      code: "internal",
      message: HTTP_MESSAGES.unreachable,
    });
    server.offline = false;
    server.rpc = () => ({ status: 500, body: "oops" });
    await expect(transport.listSessions()).rejects.toEqual(statusError(500));
    server.rpc = () => ({ status: 200, body: { kind: "result", id: 999, result: [] } });
    await expect(transport.listSessions()).rejects.toEqual({
      code: "internal",
      message: HTTP_MESSAGES.badReply,
    });
  });

  it("forwards openInBrowser to the server", async () => {
    const { server, transport } = setup();
    server.rpc = (request) => ({
      kind: "error",
      id: request.id,
      error: { code: "unsupported", message: "Not in a browser." },
    });
    await expect(transport.openInBrowser("session-1")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(transport.openInBrowser()).rejects.toMatchObject({ code: "unsupported" });
    expect(server.calls.map((c) => c.body)).toEqual([
      { id: 1, method: "openInBrowser", params: { key: "session-1" } },
      { id: 2, method: "openInBrowser", params: {} },
    ]);
  });
});

describe("HTTP transport live subscriptions", () => {
  it("streams newline-delimited live messages, including lines split across chunks", async () => {
    const { server, transport } = setup();
    const updates: LiveUpdate[] = [];
    transport.subscribe("session-1", (update) => updates.push(update));
    await settle();
    const stream = server.streams[0];
    expect(stream?.call.url).toBe("/api/live");
    expect(stream?.call.body).toEqual({ id: 1, key: "session-1" });
    expect(stream?.call.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    const first = JSON.stringify({
      kind: "live",
      subscriptionId: 1,
      key: "session-1",
      update: { type: "replay", replay: makeModel(10), live: "busy" },
    });
    stream?.write(first.slice(0, 40));
    await settle();
    expect(updates).toEqual([]);
    stream?.write(`${first.slice(40)}\n\n`);
    stream?.send({
      kind: "live",
      subscriptionId: 1,
      key: "session-1",
      update: { type: "replay", replay: makeModel(20), live: "idle" },
    });
    await settle();
    expect(updates).toEqual([
      { type: "replay", replay: makeModel(10), live: "busy" },
      { type: "replay", replay: makeModel(20), live: "idle" },
    ]);
    stream?.send({ kind: "live", subscriptionId: 1, key: "session-1", update: { type: "ended" } });
    await settle();
    expect(updates.at(-1)).toEqual({ type: "ended" });
    expect(stream?.aborted).toBe(true);
  });

  it("gives each subscription its own request and id", async () => {
    const { server, transport } = setup();
    transport.subscribe("session-1", () => {});
    transport.subscribe("session-1", () => {});
    await settle();
    expect(server.streams.map((s) => s.call.body)).toEqual([
      { id: 1, key: "session-1" },
      { id: 2, key: "session-1" },
    ]);
  });

  it("aborts the request to unsubscribe and delivers nothing after", async () => {
    const { server, transport } = setup();
    const listener = vi.fn();
    const stop = transport.subscribe("session-1", listener);
    await settle();
    stop();
    stop();
    expect(server.streams[0]?.aborted).toBe(true);
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });

  it("ends with an error when the token is refused or the server cannot be reached", async () => {
    const refused = setup();
    refused.server.liveStatus = 401;
    const onRefused = vi.fn();
    refused.transport.subscribe("session-1", onRefused);
    await settle();
    expect(onRefused).toHaveBeenCalledWith({
      type: "error",
      error: { code: "unauthorized", message: HTTP_MESSAGES.refused },
    });

    const offline = setup();
    offline.server.offline = true;
    const onOffline = vi.fn();
    offline.transport.subscribe("session-1", onOffline);
    await settle();
    expect(onOffline).toHaveBeenCalledWith({
      type: "error",
      error: { code: "internal", message: HTTP_MESSAGES.unreachable },
    });
  });

  it("ends with an error when the stream closes early or sends a bad line", async () => {
    const { server, transport } = setup();
    const closed = vi.fn();
    const garbled = vi.fn();
    transport.subscribe("session-1", closed);
    transport.subscribe("session-2", garbled);
    await settle();
    server.streams[0]?.end();
    server.streams[1]?.write("not json\n");
    await settle();
    expect(closed).toHaveBeenCalledWith({
      type: "error",
      error: { code: "internal", message: HTTP_MESSAGES.liveClosed },
    });
    expect(garbled).toHaveBeenCalledWith({
      type: "error",
      error: { code: "internal", message: HTTP_MESSAGES.badReply },
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("passes on a server error message and an invalid replay as error updates", async () => {
    const { server, transport } = setup();
    const errored = vi.fn();
    const invalid = vi.fn();
    transport.subscribe("missing", errored);
    transport.subscribe("session-1", invalid);
    await settle();
    server.streams[0]?.send({
      kind: "error",
      id: 1,
      error: { code: "not-found", message: "Gone." },
    });
    server.streams[1]?.write(
      `${JSON.stringify({
        kind: "live",
        subscriptionId: 2,
        key: "session-1",
        update: { type: "replay", replay: { formatVersion: 7 }, live: "busy" },
      })}\n`,
    );
    await settle();
    expect(errored).toHaveBeenCalledWith({
      type: "error",
      error: { code: "not-found", message: "Gone." },
    });
    expect(invalid).toHaveBeenCalledWith({
      type: "error",
      error: expect.objectContaining({ code: "invalid" }),
    });
    expect(server.streams[1]?.aborted).toBe(true);
  });

  it("ignores live messages for another subscription id", async () => {
    const { server, transport } = setup();
    const listener = vi.fn();
    transport.subscribe("session-1", listener);
    await settle();
    server.streams[0]?.send({
      kind: "live",
      subscriptionId: 9,
      key: "x",
      update: { type: "ended" },
    });
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("readLines", () => {
  it("reads a body without a stream from its text", async () => {
    const response = { body: null, text: async () => "a\n\nb\nc" } as unknown as Response;
    const lines: string[] = [];
    for await (const line of readLines(response)) lines.push(line);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("decodes multi-byte characters split across chunks and keeps a last unterminated line", async () => {
    const bytes = new TextEncoder().encode("café\nend");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    const response = { body } as unknown as Response;
    const lines: string[] = [];
    for await (const line of readLines(response)) lines.push(line);
    expect(lines).toEqual(["café", "end"]);
  });
});

describe("statusError", () => {
  it("maps 401 and 403 to unauthorized and anything else to internal", () => {
    expect(statusError(401).code).toBe("unauthorized");
    expect(statusError(403).code).toBe("unauthorized");
    expect(statusError(502)).toEqual({
      code: "internal",
      message: "The Orbitrace server answered with status 502.",
    });
  });
});
