/**
 * Helpers for the loopback server tests: a synthetic app folder, raw HTTP requests (so a test
 * controls every header, including Host), a reader for newline-delimited live streams, and
 * session replayers over the synthetic fixture tree.
 *
 * Nothing here reads the real home folder or config folder.
 */
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionChangeListener, SourceAdapter, SourceRoot } from "@orbitrace/core";
import { SCENARIO_NAMES, fixturePaths } from "@orbitrace/fixtures";
import {
  claudeCodeAdapter,
  createSessionReplayer,
  type SessionReplayer,
} from "@orbitrace/core/node";
import { resolveRoots, type HostContext } from "../src/sessions.js";
import { makeFakeMachine, makeTempDir, type FakeMachine } from "./helpers.js";

/** Text of a file outside the app folder. A traversal that worked would return it. */
export const OUTSIDE_SECRET = "outside-the-app-folder-synthetic-marker";

export interface AppFolder {
  /** The folder to serve. */
  readonly appDir: string;
  /** A file beside the app folder, never to be served. */
  readonly outsideFile: string;
}

/** A small synthetic web app, a file beside it and a symlink inside it pointing at that file. */
export function makeAppFolder(): AppFolder {
  const root = makeTempDir();
  const appDir = join(root, "app");
  mkdirSync(join(appDir, "assets"), { recursive: true });
  writeFileSync(
    join(appDir, "index.html"),
    '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body></body></html>',
  );
  writeFileSync(join(appDir, "assets", "app.js"), "export const example = 1;\n");
  writeFileSync(join(appDir, "assets", "app.css"), "body { color: white; }\n");
  writeFileSync(join(appDir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  writeFileSync(join(appDir, "data.bin"), Buffer.from([1, 2, 3]));
  writeFileSync(join(appDir, ".hidden"), OUTSIDE_SECRET);
  const outsideFile = join(root, "secret.txt");
  writeFileSync(outsideFile, OUTSIDE_SECRET);
  mkdirSync(join(root, "app-sibling"));
  writeFileSync(join(root, "app-sibling", "x.txt"), OUTSIDE_SECRET);
  try {
    symlinkSync(outsideFile, join(appDir, "escape.txt"));
    symlinkSync(root, join(appDir, "escape-dir"), "dir");
  } catch {
    // Creating symlinks may need extra rights on Windows; the symlink test checks for the link.
  }
  return { appDir, outsideFile };
}

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  /** Sent as given. `host` defaults to `127.0.0.1:<port>`. */
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** Connect to this address instead of 127.0.0.1. */
  readonly address?: string;
}

/** One HTTP request to the server. Rejects on a connection error. */
export function send(port: number, options: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: options.address ?? "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/** Headers of an authorized JSON API request. */
export function apiHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra };
}

/** POST a JSON body to `/api/rpc` with the token. */
export function rpc(port: number, token: string, body: unknown): Promise<Reply> {
  return send(port, {
    method: "POST",
    path: "/api/rpc",
    headers: apiHeaders(token),
    body: JSON.stringify(body),
  });
}

/**
 * Write raw bytes to the port and collect everything the server sends until it closes. The
 * socket is not half-closed, so the request must ask for `Connection: close`.
 */
export function rawExchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(text));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    socket.setTimeout(5000, () => socket.destroy());
  });
}

/** Whether a TCP connection to `address:port` is refused (or fails in any way). */
export function connectionRefused(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

export interface LiveReader {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Resolves with the first `count` parsed lines. */
  lines(count: number): Promise<unknown[]>;
  /** Resolves when the server ends the stream, with every parsed line. */
  ended(): Promise<unknown[]>;
  /** Abort the request, as the app does to unsubscribe. */
  abort(): void;
}

/** Open `POST /api/live` and read its newline-delimited JSON. */
export function openLive(
  port: number,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<LiveReader> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/live",
        headers: { host: `127.0.0.1:${port}`, ...apiHeaders(token), ...headers },
        agent: false,
      },
      (res) => {
        const parsed: unknown[] = [];
        let buffer = "";
        let done = false;
        const waiters: (() => void)[] = [];
        const notify = (): void => {
          for (const waiter of waiters.splice(0)) waiter();
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() !== "") parsed.push(JSON.parse(line) as unknown);
            newline = buffer.indexOf("\n");
          }
          notify();
        });
        const finish = (): void => {
          done = true;
          notify();
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
        const waitFor = (ready: () => boolean): Promise<unknown[]> =>
          new Promise((done2) => {
            const check = (): void => {
              if (ready()) done2([...parsed]);
              else waiters.push(check);
            };
            check();
          });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          lines: (count) => waitFor(() => parsed.length >= count || done),
          ended: () => waitFor(() => done),
          abort: () => req.destroy(),
        });
      },
    );
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.end(JSON.stringify(body));
  });
}

export interface FixtureSessions {
  readonly machine: FakeMachine;
  readonly host: HostContext;
  readonly roots: readonly SourceRoot[];
}

/** The synthetic fixture tree in a temporary folder, and the roots that point at it only. */
export async function fixtureSessions(): Promise<FixtureSessions> {
  const machine = makeFakeMachine();
  const host: HostContext = {
    platform: process.platform,
    homeDir: machine.home,
    env: {},
    cwd: machine.root,
  };
  const { roots } = await resolveRoots(host, {
    configDirs: [machine.configDir],
    extraRoots: false,
  });
  return { machine, host, roots };
}

export interface WatchingReplayer {
  readonly replayer: SessionReplayer;
  /** Report a change to every open watch, as a file watcher would. */
  trigger(): void;
  /** Number of watches open now. */
  activeWatches(): number;
  /** Number of watches stopped so far. */
  stoppedWatches(): number;
}

/**
 * A replayer over the fixture roots whose adapter can watch: the Claude Code adapter with a
 * `watchSession` the test drives by hand. Each `trigger` makes every open subscription rebuild.
 */
export function watchingReplayer(roots: readonly SourceRoot[]): WatchingReplayer {
  const listeners = new Set<() => void>();
  let stopped = 0;
  const adapter: SourceAdapter = {
    ...claudeCodeAdapter,
    watchSession(ref, listener: SessionChangeListener) {
      const entry = (): void => listener(ref);
      listeners.add(entry);
      return () => {
        if (listeners.delete(entry)) stopped += 1;
      };
    },
  };
  return {
    replayer: createSessionReplayer({ adapters: [adapter], roots }),
    trigger: () => {
      for (const listener of [...listeners]) listener();
    },
    activeWatches: () => listeners.size,
    stoppedWatches: () => stopped,
  };
}

/** Resolve once `check` is true, polling every 10 ms, or reject after `timeoutMs`. */
export async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The same adapter with no `watchSession`, as a runtime without live support would be. */
export function withoutWatch(adapter: SourceAdapter): SourceAdapter {
  return {
    runtime: adapter.runtime,
    displayName: adapter.displayName,
    resolveRoots: (context) => adapter.resolveRoots(context),
    listSessions: (root, options) => adapter.listSessions(root, options),
    openSession: (ref) => adapter.openSession(ref),
  };
}

/** The main transcript of the fixture session with `sessionId` in a fake machine. */
export function fixtureTranscript(machine: FakeMachine, sessionId: string): string {
  for (const name of SCENARIO_NAMES) {
    const paths = fixturePaths(name, machine.fixturesDir);
    if (paths.sessionId === sessionId) return paths.transcript;
  }
  throw new Error("no fixture session with that id");
}

/**
 * Append one more assistant line with one tool call to a synthetic transcript, as a running
 * session would. It copies the shape of the transcript's last tool-calling assistant line with
 * new invented ids, a time after the latest one in the file and the last line as its parent.
 */
export function appendToolCall(transcript: string, n = 1): void {
  const lines = readFileSync(transcript, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const isToolCall = (line: Record<string, unknown>): boolean => {
    const message = line.message as { content?: unknown } | undefined;
    return (
      line.type === "assistant" &&
      Array.isArray(message?.content) &&
      message.content.some((part) => (part as { type?: unknown }).type === "tool_use")
    );
  };
  const template = [...lines].reverse().find(isToolCall);
  const last = lines.at(-1);
  if (template === undefined || last === undefined) throw new Error("no tool call to copy");
  const message = template.message as { content: Record<string, unknown>[] };
  const tool = message.content.find((part) => part.type === "tool_use") as Record<string, unknown>;
  const times = lines
    .map((line) => (typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) throw new Error("no timestamp to follow");
  const time = Math.max(...times) + 1000;
  const line = {
    ...template,
    uuid: `00000000-0000-4000-8000-${String(900000000000 + n)}`,
    parentUuid: last.uuid,
    timestamp: new Date(time).toISOString(),
    requestId: `req_synthetic_appended_${n}`,
    message: {
      ...message,
      id: `msg_synthetic_appended_${n}`,
      content: [{ ...tool, id: `toolu_synthetic_appended_${n}` }],
    },
  };
  appendFileSync(transcript, `${JSON.stringify(line)}\n`);
}
