/**
 * The loopback server (#17) against the threats in docs/architecture.md, each named in its test,
 * plus the routes working as the lead's wire layout says. Synthetic app folder and synthetic
 * fixture sessions only.
 */
import { lstatSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  listSessions,
  toSessionSummary,
  validateReplayModel,
  type SessionSummary,
} from "@orbitrace/core";
import { claudeCodeAdapter, type SessionReplayer } from "@orbitrace/core/node";
import type { TransportMessage } from "@orbitrace/app/transport";
import { createReplayer } from "../src/sessions.js";
import { SERVER_MESSAGES } from "../src/server/rpc.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  LIVE_CONTENT_TYPE,
  ServerStartError,
  startServer,
  type LoopbackServer,
} from "../src/server/server.js";
import { CONTENT_SECURITY_POLICY } from "../src/server/security.js";
import { removeTempDirs } from "./helpers.js";
import {
  OUTSIDE_SECRET,
  apiHeaders,
  appendToolCall,
  connectionRefused,
  eventually,
  fixtureSessions,
  fixtureTranscript,
  makeAppFolder,
  openLive,
  rawExchange,
  rpc,
  send,
  watchingReplayer,
  withoutWatch,
  type AppFolder,
  type FixtureSessions,
  type Reply,
} from "./server-helpers.js";

let app: AppFolder;
let fixtures: FixtureSessions;
let summaries: readonly SessionSummary[];
const running: LoopbackServer[] = [];

/** A replayer that counts calls and never answers with data, for the refusal tests. */
function countingReplayer(): SessionReplayer & { calls: number } {
  const replayer = {
    calls: 0,
    list: async () => {
      replayer.calls += 1;
      return [];
    },
    find: async () => {
      replayer.calls += 1;
      throw new Error("not used");
    },
    load: async () => {
      replayer.calls += 1;
      throw new Error("not used");
    },
    follow: () => {
      replayer.calls += 1;
      return () => undefined;
    },
  };
  return replayer;
}

async function start(
  replayer: SessionReplayer = createReplayer(fixtures.roots),
  extra: { maxLiveStreams?: number; port?: number } = {},
): Promise<LoopbackServer> {
  const server = await startServer({ replayer, appDir: app.appDir, ...extra });
  running.push(server);
  return server;
}

function expectNoCors(reply: Reply): void {
  expect(Object.keys(reply.headers).filter((name) => name.startsWith("access-control-"))).toEqual(
    [],
  );
}

function errorCode(reply: Reply): string {
  return (JSON.parse(reply.body) as { error: { code: string } }).error.code;
}

beforeAll(async () => {
  app = makeAppFolder();
  fixtures = await fixtureSessions();
  summaries = (await listSessions(fixtures.roots, [claudeCodeAdapter])).map(toSessionSummary);
  if (summaries.length < 2) throw new Error("The fixture tree should hold several sessions.");
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

afterAll(() => {
  removeTempDirs();
});

describe("start-up", () => {
  it("threat: the server listening on anything other than loopback", async () => {
    const server = await start();
    expect(server.host).toBe("127.0.0.1");
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    // IPv6 loopback and every non-loopback address of this machine are refused.
    expect(await connectionRefused("::1", server.port)).toBe(true);
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((info) => info !== undefined && !info.internal && info.family === "IPv4")
      .map((info) => (info as { address: string }).address);
    for (const address of external) {
      expect(await connectionRefused(address, server.port)).toBe(true);
    }
    expect((await send(server.port)).status).toBe(200);
  });

  it("chooses a new random port and a new token of at least 32 bytes on every start", async () => {
    const one = await start();
    const two = await start();
    expect(one.port).not.toBe(two.port);
    expect(one.token).not.toBe(two.token);
    for (const token of [one.token, two.token]) {
      expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(32);
    }
  });

  it("listens on the port it is given, and reports a port in use", async () => {
    const first = await start();
    await expect(start(undefined, { port: first.port })).rejects.toBeInstanceOf(ServerStartError);
    await expect(start(undefined, { port: first.port })).rejects.toMatchObject({
      reason: "port-in-use",
    });
    const port = first.port;
    await first.close();
    running.splice(running.indexOf(first), 1);
    const again = await start(undefined, { port });
    expect(again.port).toBe(port);
  });

  it("builds the link with the token and the key in the fragment", async () => {
    const server = await start();
    expect(server.link()).toBe(`${server.origin}/#t=${server.token}`);
    expect(server.link("claude-code:abcd")).toBe(
      `${server.origin}/#t=${server.token}&key=claude-code:abcd`,
    );
  });
});

describe("Host header", () => {
  it("threat: DNS rebinding (a wrong Host is refused, for the app and the API)", async () => {
    const server = await start();
    const wrongHosts = [
      `rebind.example:${server.port}`,
      "rebind.example",
      `127.0.0.1:${server.port + 1}`,
      "127.0.0.1",
      `localhost.:${server.port}`,
      `[::1]:${server.port}`,
      `0.0.0.0:${server.port}`,
    ];
    for (const host of wrongHosts) {
      const page = await send(server.port, { headers: { host } });
      expect(page.status).toBe(403);
      expect(errorCode(page)).toBe("unauthorized");
      const api = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { host, ...apiHeaders(server.token) },
        body: JSON.stringify({ id: 1, method: "listSessions", params: {} }),
      });
      expect(api.status).toBe(403);
      expect(api.body).not.toContain("claude-code:");
      expectNoCors(api);
    }
  });

  it("threat: DNS rebinding (a request with no Host header is refused)", async () => {
    const server = await start();
    const reply = await rawExchange(server.port, "GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 (400|403) /);
    expect(reply).not.toContain("<!doctype html>");
  });

  it("answers to 127.0.0.1:<port> and localhost:<port>", async () => {
    const server = await start();
    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `LOCALHOST:${server.port}`,
    ]) {
      expect((await send(server.port, { headers: { host } })).status).toBe(200);
      const api = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { host, ...apiHeaders(server.token) },
        body: JSON.stringify({ id: 1, method: "listSessions", params: {} }),
      });
      expect(api.status).toBe(200);
    }
  });
});

describe("token and origin", () => {
  it("threat: another local web page trying to read the API without the token", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const body = JSON.stringify({ id: 1, method: "listSessions", params: {} });
    // A page on another port of 127.0.0.1, as a browser would send it.
    const otherPage = {
      origin: `http://127.0.0.1:${server.port + 1}`,
      "sec-fetch-site": "same-site",
    };
    const attempts: Reply[] = [
      await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": "application/json", ...otherPage },
        body,
      }),
      await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": "application/json", origin: "https://site.example" },
        body,
      }),
      await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body,
      }),
      // Even with the token, a request a browser marks as coming from another page is refused.
      await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { ...apiHeaders(server.token), ...otherPage },
        body,
      }),
      // No browser headers and no token: refused by the token check.
      await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": "application/json" },
        body,
      }),
      await send(server.port, { method: "GET", path: "/api/rpc" }),
    ];
    expect(attempts.map((reply) => reply.status)).toEqual([403, 403, 403, 403, 401, 405]);
    for (const reply of attempts) {
      expectNoCors(reply);
      expect(reply.headers["set-cookie"]).toBeUndefined();
      expect(errorCode(reply)).toMatch(/^(unauthorized|unsupported)$/);
    }
    expect(replayer.calls).toBe(0);
  });

  it("threat: another local web page sending a CORS preflight (OPTIONS is refused, no CORS headers)", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    for (const path of ["/api/rpc", "/api/live", "/"]) {
      const reply = await send(server.port, {
        method: "OPTIONS",
        path,
        headers: {
          origin: `http://127.0.0.1:${server.port + 1}`,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(reply.status).toBe(405);
      expectNoCors(reply);
    }
    expect(replayer.calls).toBe(0);
  });

  it("threat: a wrong token", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const other = await start(replayer);
    const body = JSON.stringify({ id: 1, method: "listSessions", params: {} });
    const authorizations = [
      `Bearer ${other.token}`,
      `Bearer ${server.token.slice(0, -1)}`,
      `Bearer ${server.token}x`,
      `Bearer ${server.token.toUpperCase()}`,
      `Basic ${server.token}`,
      server.token,
      "Bearer",
      "Bearer ",
      `Bearer ${server.token} ${server.token}`,
    ];
    for (const authorization of authorizations) {
      const reply = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { authorization, "content-type": "application/json" },
        body,
      });
      expect(reply.status).toBe(401);
      expect(reply.headers["www-authenticate"]).toBe("Bearer");
      expect(errorCode(reply)).toBe("unauthorized");
    }
    // The token anywhere but the Authorization header does not count.
    for (const path of [`/api/rpc?t=${server.token}`, `/api/rpc#t=${server.token}`]) {
      const reply = await send(server.port, {
        method: "POST",
        path,
        headers: { "content-type": "application/json" },
        body,
      });
      expect(reply.status).toBe(401);
    }
    const cookie = await send(server.port, {
      method: "POST",
      path: "/api/rpc",
      headers: { "content-type": "application/json", cookie: `t=${server.token}` },
      body,
    });
    expect(cookie.status).toBe(401);
    expect(replayer.calls).toBe(0);
  });

  it("threat: a cross-origin POST with a simple content type (what a plain HTML form can send)", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const simpleTypes = [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ];
    for (const type of simpleTypes) {
      // A form on another page: no token, a simple content type.
      const fromForm = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { "content-type": type },
        body: '{"id":1,"method":"listSessions","params":{}}',
      });
      expect(fromForm.status).toBe(401);
      expectNoCors(fromForm);
      // Even with the token, a body that is not declared as JSON is refused.
      const withToken = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: { authorization: `Bearer ${server.token}`, "content-type": type },
        body: '{"id":1,"method":"listSessions","params":{}}',
      });
      expect(withToken.status).toBe(415);
    }
    const noType = await send(server.port, {
      method: "POST",
      path: "/api/rpc",
      headers: { authorization: `Bearer ${server.token}` },
      body: "{}",
    });
    expect(noType.status).toBe(415);
    expect(errorCode(noType)).toBe("bad-request");
    const compressed = await send(server.port, {
      method: "POST",
      path: "/api/rpc",
      headers: apiHeaders(server.token, { "content-encoding": "gzip" }),
      body: "{}",
    });
    expect(compressed.status).toBe(415);
    expect(replayer.calls).toBe(0);
  });
});

describe("request body", () => {
  it("threat: an oversized body (declared length)", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const reply = await send(server.port, {
      method: "POST",
      path: "/api/rpc",
      headers: apiHeaders(server.token, { "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) }),
    });
    expect(reply.status).toBe(413);
    expect(errorCode(reply)).toBe("bad-request");
    expect(reply.headers.connection).toBe("close");
    expect(replayer.calls).toBe(0);
  });

  it("threat: an oversized body (chunked, no declared length)", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const big = Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1024, 0x20);
    const outcome = await send(server.port, {
      method: "POST",
      path: "/api/rpc",
      headers: apiHeaders(server.token, { "transfer-encoding": "chunked" }),
      body: big,
    }).then(
      (reply) => reply.status,
      (error: NodeJS.ErrnoException) => error.code,
    );
    // The server answers 413 and closes; the client may see the reply or the closed socket.
    expect([413, "ECONNRESET", "EPIPE"]).toContain(outcome);
    expect(replayer.calls).toBe(0);
    // The server is still healthy afterwards.
    expect((await send(server.port)).status).toBe(200);
  });

  it("refuses a body that is not JSON or not a valid request", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const bodies = [
      "not json",
      "[]",
      "null",
      JSON.stringify({ id: -1, method: "listSessions", params: {} }),
      JSON.stringify({ id: 1, method: "readFile", params: { path: "x" } }),
      JSON.stringify({ id: 1, method: "loadReplay", params: { key: 5 } }),
      JSON.stringify({ id: 1, method: "listSessions" }),
    ];
    for (const body of bodies) {
      const reply = await send(server.port, {
        method: "POST",
        path: "/api/rpc",
        headers: apiHeaders(server.token),
        body,
      });
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({
        error: { code: "bad-request", message: SERVER_MESSAGES.badRequest },
      });
    }
    expect(replayer.calls).toBe(0);
  });
});

describe("static files", () => {
  it("serves the app with content types and the security headers, without a token", async () => {
    const server = await start();
    const cases: [string, string][] = [
      ["/", "text/html; charset=utf-8"],
      ["/index.html", "text/html; charset=utf-8"],
      ["/assets/app.js", "text/javascript; charset=utf-8"],
      ["/assets/app.css", "text/css; charset=utf-8"],
      ["/favicon.svg", "image/svg+xml"],
      ["/data.bin", "application/octet-stream"],
      ["/assets/app.js?v=1", "text/javascript; charset=utf-8"],
    ];
    for (const [path, type] of cases) {
      const reply = await send(server.port, { path });
      expect(reply.status).toBe(200);
      expect(reply.headers["content-type"]).toBe(type);
      expect(reply.headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["referrer-policy"]).toBe("no-referrer");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
      expect(reply.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expectNoCors(reply);
      expect(reply.headers["set-cookie"]).toBeUndefined();
    }
    const head = await send(server.port, { method: "HEAD", path: "/assets/app.js" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe");
  });

  it("refuses other methods and unknown files", async () => {
    const server = await start();
    const post = await send(server.port, { method: "POST", path: "/" });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect((await send(server.port, { path: "/missing.js" })).status).toBe(404);
    expect((await send(server.port, { path: "/assets" })).status).toBe(404);
    expect((await send(server.port, { path: "/assets/" })).status).toBe(404);
  });

  it("threat: path traversal on static files", async () => {
    const server = await start();
    const paths = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E%2Fsecret.txt",
      "/..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/..\\secret.txt",
      "/%252e%252e/secret.txt",
      "/../app-sibling/x.txt",
      "/.hidden",
      "/%2ehidden",
      "/index.html%00.js",
      "//secret.txt",
      "/%",
      "/C:%5cWindows",
    ];
    for (const path of paths) {
      const reply = await rawExchange(
        server.port,
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
      );
      expect(reply).toMatch(/^HTTP\/1\.1 (400|404) /);
      expect(reply).not.toContain(OUTSIDE_SECRET);
    }
  });

  it.skipIf(process.platform === "win32")(
    "threat: path traversal through a symlink that points out of the app folder",
    async () => {
      expect(lstatSync(join(app.appDir, "escape.txt")).isSymbolicLink()).toBe(true);
      const server = await start();
      for (const path of [
        "/escape.txt",
        "/escape-dir/secret.txt",
        "/escape-dir/app-sibling/x.txt",
      ]) {
        const reply = await send(server.port, { path });
        expect(reply.status).toBe(404);
        expect(reply.body).not.toContain(OUTSIDE_SECRET);
      }
    },
  );
});

describe("POST /api/rpc", () => {
  it("lists sessions as core lists them, with Cache-Control: no-store", async () => {
    const server = await start();
    const reply = await rpc(server.port, server.token, {
      id: 7,
      method: "listSessions",
      params: { options: { limit: 2 } },
    });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expectNoCors(reply);
    const message = JSON.parse(reply.body) as TransportMessage;
    expect(message).toEqual({ kind: "result", id: 7, result: summaries.slice(0, 2) });
    expect(reply.body).not.toContain(fixtures.machine.root);
  });

  it("loads a replay that passes the replay format check", async () => {
    const server = await start();
    const key = (summaries[0] as SessionSummary).key;
    const reply = await rpc(server.port, server.token, {
      id: 8,
      method: "loadReplay",
      params: { key },
    });
    const message = JSON.parse(reply.body) as Extract<TransportMessage, { kind: "result" }>;
    expect(message.kind).toBe("result");
    expect(message.id).toBe(8);
    expect(validateReplayModel(message.result)).toBe(true);
    expect(reply.body).not.toContain(fixtures.machine.root);
  });

  it("answers an unknown key, subscribe and openInBrowser with an error message", async () => {
    const server = await start();
    const replies = await Promise.all([
      rpc(server.port, server.token, {
        id: 1,
        method: "loadReplay",
        params: { key: "claude-code:0000" },
      }),
      rpc(server.port, server.token, {
        id: 2,
        method: "subscribe",
        params: { key: "claude-code:0000" },
      }),
      rpc(server.port, server.token, { id: 3, method: "openInBrowser", params: {} }),
      rpc(server.port, server.token, {
        id: 4,
        method: "unsubscribe",
        params: { subscriptionId: 99 },
      }),
    ]);
    const messages = replies.map((reply) => JSON.parse(reply.body) as TransportMessage);
    expect(messages[0]).toMatchObject({ kind: "error", id: 1, error: { code: "not-found" } });
    expect(messages[1]).toEqual({
      kind: "error",
      id: 2,
      error: { code: "unsupported", message: SERVER_MESSAGES.subscribeOverRpc },
    });
    expect(messages[2]).toEqual({
      kind: "error",
      id: 3,
      error: { code: "unsupported", message: SERVER_MESSAGES.openInBrowser },
    });
    expect(messages[3]).toEqual({ kind: "result", id: 4, result: null });
  });

  it("refuses an /api path that is not a route", async () => {
    const server = await start();
    for (const path of ["/api", "/api/", "/api/other", "/api/rpc/", "/api/rpc?x=1"]) {
      const reply = await send(server.port, {
        method: "POST",
        path,
        headers: apiHeaders(server.token),
        body: "{}",
      });
      expect(reply.status).toBe(404);
    }
  });
});

type LiveLine = Extract<TransportMessage, { kind: "live" }>;
type ReplayUpdate = Extract<LiveLine["update"], { type: "replay" }>;

/** `promise`, or a rejection after `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`not done within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The replay update of a live line, or a test failure. */
function replayOf(line: unknown): ReplayUpdate {
  const update = (line as LiveLine).update;
  if (update.type !== "replay") throw new Error(`expected a replay update, got ${update.type}`);
  return update;
}

describe("POST /api/live", () => {
  it("streams a session of the synthetic config tree end to end: the current state, then stays open while watched", async () => {
    const server = await start();
    const key = (summaries[0] as SessionSummary).key;
    const live = await openLive(server.port, server.token, { id: 11, key });
    try {
      expect(live.status).toBe(200);
      expect(live.headers["content-type"]).toBe(LIVE_CONTENT_TYPE);
      expect(live.headers["cache-control"]).toBe("no-store");
      const [first] = (await live.lines(1)) as LiveLine[];
      expect(first).toMatchObject({ kind: "live", subscriptionId: 11, key });
      expect(validateReplayModel(replayOf(first).replay)).toBe(true);
      // The Claude Code adapter watches the session, so the stream is not ended.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(server.liveStreamCount()).toBe(1);
    } finally {
      // Aborting the request is the unsubscribe.
      live.abort();
    }
    await eventually(() => server.liveStreamCount() === 0);
  });

  it("streams the current state, then ended, when the adapter cannot watch", async () => {
    const server = await start(createReplayer(fixtures.roots, [withoutWatch(claudeCodeAdapter)]));
    const key = (summaries[0] as SessionSummary).key;
    const live = await openLive(server.port, server.token, { id: 11, key });
    expect(live.status).toBe(200);
    const lines = (await live.ended()) as TransportMessage[];
    expect(lines).toHaveLength(2);
    const [first, last] = lines as [
      Extract<TransportMessage, { kind: "live" }>,
      Extract<TransportMessage, { kind: "live" }>,
    ];
    expect(first).toMatchObject({ kind: "live", subscriptionId: 11, key });
    expect(first.update.type).toBe("replay");
    const update = first.update as Extract<typeof first.update, { type: "replay" }>;
    expect(update.type).toBe("replay");
    expect(validateReplayModel(update.replay)).toBe(true);
    expect(last).toEqual({ kind: "live", subscriptionId: 11, key, update: { type: "ended" } });
    await eventually(() => server.liveStreamCount() === 0);
  });

  it(
    "sends a second update when a line is appended to a watched synthetic transcript",
    { timeout: 30_000 },
    async () => {
      // A fresh copy of the fixture tree: this test writes to it.
      const own = await fixtureSessions();
      const server = await start(createReplayer(own.roots));
      const [summary] = (await listSessions(own.roots, [claudeCodeAdapter])).map(toSessionSummary);
      const { key, sessionId } = summary as SessionSummary;
      const transcript = fixtureTranscript(own.machine, sessionId);
      const live = await openLive(server.port, server.token, { id: 41, key });
      try {
        const [first] = (await live.lines(1)) as LiveLine[];
        const before = replayOf(first).replay.totals.toolCalls;
        appendToolCall(transcript);
        // Real file watching with the command's default options: events, a settle check after
        // the watchers open and a backstop poll. Generous, for a loaded machine.
        const lines = (await within(live.lines(2), 20_000)) as LiveLine[];
        expect(lines).toHaveLength(2);
        const second = replayOf(lines[1]);
        expect(validateReplayModel(second.replay)).toBe(true);
        expect(second.replay.totals.toolCalls).toBe(before + 1);
        expect(JSON.stringify(lines)).not.toContain(own.machine.root);
      } finally {
        live.abort();
      }
      await eventually(() => server.liveStreamCount() === 0);
    },
  );

  it("sends an error update for an unknown key and ends the stream", async () => {
    const server = await start();
    const live = await openLive(server.port, server.token, { id: 12, key: "claude-code:0000" });
    const lines = (await live.ended()) as TransportMessage[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "live",
      subscriptionId: 12,
      update: { type: "error", error: { code: "not-found" } },
    });
  });

  it("sends each change while watched, and stops the watch when the client aborts", async () => {
    const watching = watchingReplayer(fixtures.roots);
    const server = await start(watching.replayer);
    const key = (summaries[0] as SessionSummary).key;
    const live = await openLive(server.port, server.token, { id: 21, key });
    await live.lines(1);
    await eventually(() => watching.activeWatches() === 1);
    watching.trigger();
    const lines = (await live.lines(2)) as Extract<TransportMessage, { kind: "live" }>[];
    expect(lines.map((line) => line.update.type)).toEqual(["replay", "replay"]);
    live.abort();
    await eventually(() => watching.activeWatches() === 0 && server.liveStreamCount() === 0);
    expect(watching.stoppedWatches()).toBe(1);
  });

  it("ends a stream when unsubscribe names its subscription id", async () => {
    const watching = watchingReplayer(fixtures.roots);
    const server = await start(watching.replayer);
    const key = (summaries[0] as SessionSummary).key;
    const live = await openLive(server.port, server.token, { id: 31, key });
    await live.lines(1);
    const reply = await rpc(server.port, server.token, {
      id: 32,
      method: "unsubscribe",
      params: { subscriptionId: 31 },
    });
    expect(JSON.parse(reply.body)).toEqual({ kind: "result", id: 32, result: null });
    const lines = await live.ended();
    expect(lines).toHaveLength(1);
    await eventually(() => watching.activeWatches() === 0 && server.liveStreamCount() === 0);
  });

  it("refuses a second stream with an open id, too many streams and a bad body", async () => {
    const watching = watchingReplayer(fixtures.roots);
    const server = await start(watching.replayer, { maxLiveStreams: 2 });
    const key = (summaries[0] as SessionSummary).key;
    const one = await openLive(server.port, server.token, { id: 1, key });
    await one.lines(1);
    const same = await send(server.port, {
      method: "POST",
      path: "/api/live",
      headers: apiHeaders(server.token),
      body: JSON.stringify({ id: 1, key }),
    });
    expect(same.status).toBe(409);
    const two = await openLive(server.port, server.token, { id: 2, key });
    await two.lines(1);
    const three = await send(server.port, {
      method: "POST",
      path: "/api/live",
      headers: apiHeaders(server.token),
      body: JSON.stringify({ id: 3, key }),
    });
    expect(three.status).toBe(429);
    for (const body of [{ id: "x", key }, { id: 4 }, { id: 4, key: "" }]) {
      const reply = await send(server.port, {
        method: "POST",
        path: "/api/live",
        headers: apiHeaders(server.token),
        body: JSON.stringify(body),
      });
      expect(reply.status).toBe(400);
    }
    one.abort();
    two.abort();
  });

  it("requires the token like every /api request", async () => {
    const replayer = countingReplayer();
    const server = await start(replayer);
    const reply = await send(server.port, {
      method: "POST",
      path: "/api/live",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, key: "claude-code:0000" }),
    });
    expect(reply.status).toBe(401);
    expect(replayer.calls).toBe(0);
  });
});

describe("shutdown", () => {
  it("closes live streams and watches, refuses new connections and can be called twice", async () => {
    const watching = watchingReplayer(fixtures.roots);
    const server = await startServer({ replayer: watching.replayer, appDir: app.appDir });
    const key = (summaries[0] as SessionSummary).key;
    const live = await openLive(server.port, server.token, { id: 41, key });
    await live.lines(1);
    await eventually(() => watching.activeWatches() === 1);
    await Promise.all([server.close(), server.close()]);
    await live.ended();
    expect(watching.activeWatches()).toBe(0);
    expect(watching.stoppedWatches()).toBe(1);
    expect(server.liveStreamCount()).toBe(0);
    expect(await connectionRefused("127.0.0.1", server.port)).toBe(true);
  });
});
