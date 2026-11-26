/**
 * The loopback server behind `orbitrace open` (#17), on Node's own `http` module.
 *
 * Routes (lead's wire-layout decision on #17; the threat model is in docs/architecture.md):
 * - `GET`/`HEAD` of any other path: a file of the built web app. No token: the files hold no
 *   user data.
 * - `POST /api/rpc`: one `TransportRequest` in, one `TransportMessage` out.
 * - `POST /api/live`: `{ id, key }` in, newline-delimited `live` `TransportMessage`s out, the
 *   first being the current state, until `ended`, `error` or the client aborts.
 *
 * Every request must name this server in its Host header. Every `/api` request must also be a
 * POST, carry `Authorization: Bearer <token>`, come from this server's own page when a browser
 * says where it comes from, and send a JSON body no larger than the limit. No CORS header is
 * ever sent and preflights are refused.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { SessionReplayer } from "@orbitrace/core/node";
import type { TransportErrorCode, Unsubscribe } from "@orbitrace/core";
import type { TransportMessage } from "@orbitrace/app/transport";
import { buildLink } from "./link.js";
import { handleRpc, parseLiveRequest, parseRpcRequest, SERVER_MESSAGES } from "./rpc.js";
import {
  LOOPBACK_HOST,
  SECURITY_HEADERS,
  bearerToken,
  createToken,
  isAllowedHost,
  isJsonContentType,
  isSameOriginRequest,
  tokenMatches,
} from "./security.js";
import { contentTypeFor, readStaticFile } from "./static-files.js";

/** Largest request body accepted, in bytes. Real requests are under 1 KB. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Most live streams open at once. */
export const DEFAULT_MAX_LIVE_STREAMS = 16;

/** Content type of a live stream. */
export const LIVE_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export const RPC_PATH = "/api/rpc";
export const LIVE_PATH = "/api/live";

export interface LoopbackServerOptions {
  /** Answers the API requests. */
  readonly replayer: SessionReplayer;
  /** The folder of the built web app (`appBundleDir()`). */
  readonly appDir: string;
  /** Port to listen on. 0 or left out: a free port chosen by the system. */
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly maxLiveStreams?: number;
}

export interface LoopbackServer {
  /** Always `127.0.0.1`. */
  readonly host: string;
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The token of this start. Anyone holding it can read every session the CLI can see. */
  readonly token: string;
  /** The link to the app, with the token and an optional session key in the fragment. */
  link(key?: string): string;
  /** Number of live streams open now. */
  liveStreamCount(): number;
  /** End every live stream, stop every watch, close every connection and stop listening. */
  close(): Promise<void>;
}

/** Why the server could not start. */
export class ServerStartError extends Error {
  /** `port-in-use`, `port-denied` or `not-loopback`; anything else is `failed`. */
  readonly reason: "port-in-use" | "port-denied" | "not-loopback" | "failed";

  constructor(reason: ServerStartError["reason"]) {
    super(`The local server could not start (${reason}).`);
    this.name = "ServerStartError";
    this.reason = reason;
  }
}

/** The JSON body of a reply the server refuses before any `TransportMessage` exists. */
export interface ServerErrorBody {
  readonly error: { readonly code: TransportErrorCode; readonly message: string };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(data.length),
    ...extra,
  });
  res.end(data);
}

/**
 * Refuse a request with a fixed message. `Connection: close` makes Node close the socket after
 * the reply, so a body that was not read is never parsed as a next request.
 */
function refuse(
  res: ServerResponse,
  status: number,
  code: TransportErrorCode,
  message: string,
  extra: Record<string, string> = {},
): void {
  const body: ServerErrorBody = { error: { code, message } };
  sendJson(res, status, body, { Connection: "close", ...extra });
}

type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "too-large" | "bad-json" | "aborted" };

/** Read and parse a JSON body of at most `limit` bytes. Stops reading as soon as it is over. */
function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    return Promise.resolve({ ok: false, reason: "too-large" });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        // Discard the rest instead of keeping it in memory.
        req.resume();
        settle({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => {
      try {
        settle({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
      } catch {
        settle({ ok: false, reason: "bad-json" });
      }
    });
    req.once("aborted", () => settle({ ok: false, reason: "aborted" }));
    req.once("error", () => settle({ ok: false, reason: "aborted" }));
  });
}

interface LiveStream {
  /** End the stream: stop following, end the reply. Safe to call more than once. */
  readonly end: () => void;
}

/** Start the loopback server. Rejects with a `ServerStartError` when it cannot listen. */
export async function startServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const { replayer } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxLiveStreams = options.maxLiveStreams ?? DEFAULT_MAX_LIVE_STREAMS;
  const realRoot = await realpath(options.appDir);
  const token = createToken();
  const streams = new Map<number, LiveStream>();
  let port = 0;
  let closing = false;

  async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      refuse(res, 405, "unsupported", SERVER_MESSAGES.method, { Allow: "GET, HEAD" });
      return;
    }
    const file = await readStaticFile(realRoot, req.url ?? "");
    if (file === null) {
      refuse(res, 404, "not-found", SERVER_MESSAGES.notFound);
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": contentTypeFor(file.name),
      "Content-Length": String(file.data.length),
    });
    res.end(req.method === "HEAD" ? undefined : file.data);
  }

  function openLiveStream(res: ServerResponse, id: number, key: string): void {
    let done = false;
    // Filled in once `follow` returns; `end` may run before that (the client already left).
    const following: { stop?: Unsubscribe } = {};
    const end = (): void => {
      if (done) return;
      done = true;
      streams.delete(id);
      following.stop?.();
      if (!res.writableEnded) res.end();
    };
    streams.set(id, { end });
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": LIVE_CONTENT_TYPE });
    res.flushHeaders();
    // The client aborting the request is the unsubscribe.
    res.once("close", end);
    following.stop = replayer.follow(key, (update) => {
      if (done) return;
      const message: TransportMessage = { kind: "live", subscriptionId: id, key, update };
      res.write(`${JSON.stringify(message)}\n`);
      if (update.type === "ended" || update.type === "error") end();
    });
    if (done) following.stop();
  }

  async function serveApi(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
  ): Promise<void> {
    if (closing) {
      refuse(res, 503, "internal", SERVER_MESSAGES.shuttingDown);
      return;
    }
    // OPTIONS (a CORS preflight) is refused here like every other method but POST.
    if (req.method !== "POST") {
      refuse(res, 405, "unsupported", SERVER_MESSAGES.method, { Allow: "POST" });
      return;
    }
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (!isSameOriginRequest(origin, typeof fetchSite === "string" ? fetchSite : undefined, port)) {
      refuse(res, 403, "unauthorized", SERVER_MESSAGES.crossOrigin);
      return;
    }
    if (!tokenMatches(bearerToken(req.headers.authorization), token)) {
      refuse(res, 401, "unauthorized", SERVER_MESSAGES.unauthorized, {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }
    const encoding = req.headers["content-encoding"];
    if (
      !isJsonContentType(req.headers["content-type"]) ||
      (encoding ?? "identity") !== "identity"
    ) {
      refuse(res, 415, "unsupported", SERVER_MESSAGES.contentType);
      return;
    }
    if (target !== RPC_PATH && target !== LIVE_PATH) {
      refuse(res, 404, "not-found", SERVER_MESSAGES.notFound);
      return;
    }
    const body = await readJsonBody(req, maxBodyBytes);
    if (!body.ok) {
      if (body.reason === "too-large") refuse(res, 413, "unsupported", SERVER_MESSAGES.tooLarge);
      else if (body.reason === "bad-json") {
        refuse(res, 400, "unsupported", SERVER_MESSAGES.badRequest);
      } else res.destroy();
      return;
    }

    if (target === RPC_PATH) {
      const request = parseRpcRequest(body.value);
      if (request === null) {
        refuse(res, 400, "unsupported", SERVER_MESSAGES.badRequest);
        return;
      }
      const reply = await handleRpc(request, {
        replayer,
        unsubscribe: (subscriptionId) => streams.get(subscriptionId)?.end(),
      });
      sendJson(res, 200, reply);
      return;
    }

    const live = parseLiveRequest(body.value);
    if (live === null) {
      refuse(res, 400, "unsupported", SERVER_MESSAGES.badRequest);
      return;
    }
    if (streams.has(live.id)) {
      refuse(res, 409, "unsupported", SERVER_MESSAGES.idInUse);
      return;
    }
    if (streams.size >= maxLiveStreams) {
      refuse(res, 429, "unsupported", SERVER_MESSAGES.tooManyStreams);
      return;
    }
    openLiveStream(res, live.id, live.key);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own name.
    if (!isAllowedHost(req.headers.host, port)) {
      refuse(res, 403, "unauthorized", SERVER_MESSAGES.wrongHost);
      return;
    }
    const target = req.url ?? "";
    if (target === "/api" || target.startsWith("/api/") || target.startsWith("/api?")) {
      await serveApi(req, res, target);
      return;
    }
    await serveStatic(req, res);
  }

  const server = createServer(
    {
      requireHostHeader: true,
      maxHeaderSize: 16 * 1024,
      headersTimeout: 10_000,
      // Time to receive a whole request. A live reply may last much longer; this does not end it.
      requestTimeout: 30_000,
    },
    (req, res) => {
      handle(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else refuse(res, 500, "internal", "Something went wrong in the local server.");
      });
    },
  );
  server.maxConnections = 128;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") reject(new ServerStartError("port-in-use"));
      else if (error.code === "EACCES") reject(new ServerStartError("port-denied"));
      else reject(new ServerStartError("failed"));
    };
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port: options.port ?? 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | string | null;
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST ||
    (String(address.family) !== "IPv4" && String(address.family) !== "4")
  ) {
    server.close();
    throw new ServerStartError("not-loopback");
  }
  port = address.port;
  const origin = `http://${LOOPBACK_HOST}:${port}`;

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      closing = true;
      for (const stream of [...streams.values()]) stream.end();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closed;
  };

  return {
    host: LOOPBACK_HOST,
    port,
    origin,
    token,
    link: (key) => buildLink(origin, token, key),
    liveStreamCount: () => streams.size,
    close,
  };
}
