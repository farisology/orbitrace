// @vitest-environment node
/**
 * End to end (#93): the app's HTTP client transport (`src/http-transport.ts`) against the real
 * loopback server of the `orbitrace` command, not against stand-ins. The command runs as its
 * built binary on a synthetic config tree in a temporary folder, with `HOME` and
 * `CLAUDE_CONFIG_DIR` set in its environment before it starts (see `cli-server.ts`). The
 * transport talks to it with Node's own `fetch`.
 *
 * Covered together: the link the server prints, read by the app's `chooseHost`; `listSessions`;
 * `loadReplay`; a live subscription that gets a second update after a line is appended to the
 * watched transcript, and whose unsubscribe aborts its request; `openInBrowser`, and `subscribe`
 * sent to `/api/rpc`, refused as `unsupported`; a request without the token, and one with a wrong token, refused as
 * `unauthorized`; and a clean shutdown on SIGINT that ends an open subscription.
 *
 * Runs in the Node environment (not happy-dom), so `fetch` is Node's and nothing in the page
 * environment can stand in for the network. Skipped on Windows, where a child process cannot be
 * sent SIGINT.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateReplay, type ReplayModel, type SessionSummary } from "@orbitrace/core";
import { fixturePaths } from "@orbitrace/fixtures";
import { createHttpTransport, HTTP_MESSAGES, type FetchFunction } from "../../src/http-transport";
import { LIVE_PATH, RPC_PATH } from "../../src/protocol";
import { chooseHost, type StartupPage } from "../../src/startup";
import type { LiveUpdate, TransportError } from "../../src/transport";
import {
  appendToolCall,
  createSandbox,
  eventually,
  killIfRunning,
  removeSandbox,
  startCli,
  type RunningCli,
  type Sandbox,
} from "./cli-server";

/** One request the transport made, and the status and content type of its reply. */
interface Exchange {
  readonly path: string;
  readonly init: RequestInit;
  status?: number;
  contentType?: string | null;
}

/**
 * Node's `fetch` against the server's origin. The transport sends origin-relative paths, as it
 * does in the page; Node needs an absolute URL. Every request and reply is recorded.
 */
function recordingFetch(origin: string, log: Exchange[]): FetchFunction {
  return async (path, init) => {
    const exchange: Exchange = { path, init };
    log.push(exchange);
    const response = await fetch(new URL(path, origin), init);
    exchange.status = response.status;
    exchange.contentType = response.headers.get("content-type");
    return response;
  };
}

/** A page whose address is `link` and which has no host meta tag, as the CLI's browser tab. */
function pageAt(link: string): StartupPage & { readonly replaced: string[] } {
  const url = new URL(link);
  const replaced: string[] = [];
  return {
    replaced,
    document: { querySelector: () => null },
    location: { hash: url.hash, pathname: url.pathname, search: url.search },
    history: {
      state: null,
      replaceState: (_data, _unused, next) => {
        replaced.push(String(next));
      },
    },
  };
}

function replayOf(update: LiveUpdate | undefined): ReplayModel {
  if (update?.type !== "replay") throw new Error(`expected a replay update, got ${update?.type}`);
  return update.replay;
}

const SCENARIO = "two-waves";

describe.skipIf(process.platform === "win32")(
  "the app's HTTP transport against the CLI loopback server (#93)",
  { timeout: 60_000 },
  () => {
    let sandbox: Sandbox;
    let cli: RunningCli | undefined;
    let token: string;
    let key: string;
    let origin: string;
    /** What `chooseHost` left in the address bar after reading the fragment. */
    let addressBar: string[];
    const exchanges: Exchange[] = [];

    beforeAll(async () => {
      sandbox = createSandbox();
      cli = await startCli(sandbox);
      origin = cli.document.origin;
      // The app's side of the link: the token and the preselected session from the fragment.
      const page = pageAt(cli.document.url);
      const choice = chooseHost(page);
      if (choice.kind !== "browser") throw new Error(`chooseHost picked ${choice.kind}`);
      token = choice.token;
      key = choice.sessionKey ?? "";
      addressBar = page.replaced;
    });

    afterAll(async () => {
      await killIfRunning(cli);
      removeSandbox(sandbox);
    });

    it("reads the token and the session key from the link the server prints", () => {
      const { document } = cli as RunningCli;
      expect(document.browser).toBe("skipped");
      expect(document.origin).toBe(`http://127.0.0.1:${document.port}`);
      expect(document.url.startsWith(`${document.origin}/#`)).toBe(true);
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(key).toBe(document.key);
      expect(document.warnings).toEqual([]);
      // The token leaves the address bar as soon as the app has read it.
      expect(addressBar).toEqual(["/"]);
    });

    it("lists the synthetic sessions, with no path, and sends the request the server expects", async () => {
      const transport = createHttpTransport({ token, fetch: recordingFetch(origin, exchanges) });
      const sessions = await transport.listSessions();
      expect(sessions.length).toBeGreaterThan(1);
      expect(sessions.map((session) => session.key)).toContain(key);
      expect(sessions.map((session) => session.sessionId)).toContain(
        fixturePaths(SCENARIO, sandbox.fixturesDir).sessionId,
      );
      expect(JSON.stringify(sessions)).not.toContain(sandbox.root);
      expect(await transport.listSessions({ limit: 1 })).toHaveLength(1);

      const request = exchanges.at(-1) as Exchange;
      expect(request.path).toBe(RPC_PATH);
      expect(request.status).toBe(200);
      expect(request.init.method).toBe("POST");
      expect(request.init.credentials).toBe("omit");
      expect(request.init.headers).toEqual({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      });
    });

    it("loads a replay that passes the replay v1 schema", async () => {
      const transport = createHttpTransport({ token, fetch: recordingFetch(origin, exchanges) });
      const replay = await transport.loadReplay(key);
      expect(validateReplay(replay)).toBe(true);
      expect(replay.agents.length).toBeGreaterThan(0);
      expect(JSON.stringify(replay)).not.toContain(sandbox.root);
    });

    it("follows a session live: a second update after a line is appended, and abort unsubscribes", async () => {
      const transport = createHttpTransport({ token, fetch: recordingFetch(origin, exchanges) });
      const paths = fixturePaths(SCENARIO, sandbox.fixturesDir);
      const summary = (await transport.listSessions()).find(
        (session: SessionSummary) => session.sessionId === paths.sessionId,
      ) as SessionSummary;
      expect(summary).toBeDefined();

      const updates: LiveUpdate[] = [];
      const before = exchanges.length;
      const unsubscribe = transport.subscribe(summary.key, (update) => updates.push(update));
      await eventually(() => updates.length >= 1);
      const first = replayOf(updates[0]);
      expect(validateReplay(first)).toBe(true);

      const live = exchanges.slice(before).find((exchange) => exchange.path === LIVE_PATH);
      expect(live?.status).toBe(200);
      expect(live?.contentType).toMatch(/^application\/x-ndjson/);

      appendToolCall(paths.transcript);
      // Real file watching with the command's defaults; generous for a loaded machine.
      await eventually(() => updates.length >= 2, 30_000);
      const second = replayOf(updates[1]);
      expect(validateReplay(second)).toBe(true);
      expect(second.totals.toolCalls).toBe(first.totals.toolCalls + 1);
      expect(JSON.stringify(updates)).not.toContain(sandbox.root);

      unsubscribe();
      expect(live?.init.signal?.aborted).toBe(true);
      // The server is still serving after the client went away.
      expect((await transport.listSessions()).length).toBeGreaterThan(1);
      expect(updates).toHaveLength(2);
    });

    it("answers openInBrowser, and subscribe sent to /api/rpc, with unsupported", async () => {
      const transport = createHttpTransport({ token, fetch: recordingFetch(origin, exchanges) });
      await expect(transport.openInBrowser(key)).rejects.toMatchObject({ code: "unsupported" });
      // The transport follows sessions over /api/live; the rpc route refuses `subscribe`.
      const reply = await fetch(new URL(RPC_PATH, origin), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: 7, method: "subscribe", params: { key } }),
      });
      expect(await reply.json()).toMatchObject({
        kind: "error",
        id: 7,
        error: { code: "unsupported" },
      });
    });

    it("refuses a request without the token, and the transport with a wrong token", async () => {
      const bare = await fetch(new URL(RPC_PATH, origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, method: "listSessions", params: {} }),
      });
      expect(bare.status).toBe(401);
      expect(await bare.json()).toMatchObject({ error: { code: "unauthorized" } });

      const wrong = createHttpTransport({
        token: "not-the-token",
        fetch: recordingFetch(origin, exchanges),
      });
      const refused: TransportError = { code: "unauthorized", message: HTTP_MESSAGES.refused };
      await expect(wrong.listSessions()).rejects.toEqual(refused);
      await expect(wrong.loadReplay(key)).rejects.toEqual(refused);
      const updates: LiveUpdate[] = [];
      wrong.subscribe(key, (update) => updates.push(update));
      await eventually(() => updates.length >= 1);
      expect(updates).toEqual([{ type: "error", error: refused }]);
    });

    it("shuts down cleanly on SIGINT: exit 0, an open subscription ends, the port is closed", async () => {
      const running = cli as RunningCli;
      const transport = createHttpTransport({ token, fetch: recordingFetch(origin, exchanges) });
      const updates: LiveUpdate[] = [];
      transport.subscribe(key, (update) => updates.push(update));
      await eventually(() => updates.length >= 1);

      running.child.kill("SIGINT");
      const exit = await running.exit;
      expect(exit.code).toBe(0);
      expect(exit.stderr).toBe("");
      expect(exit.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(exit.stdout).not.toContain(sandbox.root);

      // The stream ended without `ended`: the server went away, and the app is told so.
      await eventually(() => updates.length >= 2);
      expect(updates[1]).toEqual({
        type: "error",
        error: { code: "internal", message: HTTP_MESSAGES.liveClosed },
      });
      await expect(transport.listSessions()).rejects.toEqual({
        code: "internal",
        message: HTTP_MESSAGES.unreachable,
      });
    });
  },
);
