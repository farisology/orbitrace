/**
 * `orbitrace open` as a child process of the built `dist/index.js`, against the synthetic
 * fixture tree, with a fresh environment and an empty home folder. The child is stopped with
 * SIGINT, as Ctrl+C does, and must exit by itself with code 0.
 *
 * Every run passes --no-browser: no test opens a browser. (An empty PATH is not enough: on macOS
 * the opener is still found.) The bare `orbitrace` is tested in-process in open.test.ts, with a
 * stand-in opener. Skipped on Windows, where a child process cannot be sent SIGINT.
 *
 * Every child started here is killed in `afterEach` if it is still running, so a failing or
 * timed-out test never leaves a server listening on 127.0.0.1.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { validateReplay } from "@orbitrace/core";
import type { TransportMessage } from "@orbitrace/app/transport";
import { BIN, fakeEnv, makeFakeMachine, removeTempDirs, type FakeMachine } from "./helpers.js";
import { openLive, rpc, send } from "./server-helpers.js";

let machine: FakeMachine;
/** Every child started by a test, for `afterEach`. */
const children: ChildProcess[] = [];

beforeAll(() => {
  machine = makeFakeMachine();
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(killIfRunning));
});

afterAll(() => {
  removeTempDirs();
});

/** SIGKILL a child that has not exited, and wait until it has. */
async function killIfRunning(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

interface Child {
  readonly process: ChildProcess;
  /** Resolves with the first line of stdout. */
  readonly firstLine: Promise<string>;
  /** Resolves with the exit code and everything written. */
  readonly exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function startChild(args: string[], env: Record<string, string> = {}): Child {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: machine.home,
    env: fakeEnv(machine.home, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const firstLine = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline !== -1) resolve(stdout.slice(0, newline));
    });
    child.once("exit", () => reject(new Error(`exited early: ${stderr}`)));
  });
  // A test that fails before reading the first line must not leave an unhandled rejection.
  firstLine.catch(() => undefined);
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  return { process: child, firstLine, exit };
}

describe.skipIf(process.platform === "win32")(
  "orbitrace open (built binary)",
  { timeout: 30_000 },
  () => {
    it("serves the API and a watched live stream, then exits cleanly with 0 on SIGINT", async () => {
      const child = startChild([
        "open",
        "--no-browser",
        "--json",
        "--config-dir",
        machine.configDir,
      ]);
      const doc = JSON.parse(await child.firstLine) as {
        url: string;
        origin: string;
        port: number;
        key: string;
        browser: string;
      };
      expect(doc.browser).toBe("skipped");
      expect(doc.url.startsWith(`http://127.0.0.1:${doc.port}/#t=`)).toBe(true);
      const token = new URLSearchParams(new URL(doc.url).hash.slice(1)).get("t") as string;
      expect(token.length).toBeGreaterThanOrEqual(43);

      // The real built app is served.
      const page = await send(doc.port);
      expect(page.status).toBe(200);
      expect(page.body).toContain("<title>Orbitrace</title>");
      expect(
        (await send(doc.port, { headers: { host: `rebind.example:${doc.port}` } })).status,
      ).toBe(403);

      const listed = JSON.parse(
        (await rpc(doc.port, token, { id: 1, method: "listSessions", params: {} })).body,
      ) as Extract<TransportMessage, { kind: "result" }>;
      expect((listed.result as { key: string }[])[0]?.key).toBe(doc.key);

      // The session is watched, so the stream stays open: read the current state, then abort,
      // which is the unsubscribe.
      const live = await openLive(doc.port, token, { id: 5, key: doc.key });
      const lines = (await live.lines(1)) as Extract<TransportMessage, { kind: "live" }>[];
      live.abort();
      expect(lines.map((line) => line.update.type)).toEqual(["replay"]);
      const first = lines[0] as Extract<TransportMessage, { kind: "live" }>;
      const update = first.update as Extract<typeof first.update, { type: "replay" }>;
      expect(update.type).toBe("replay");
      expect(validateReplay(update.replay)).toBe(true);

      // A stream still open when the user stops the command: its watch is stopped and the
      // process exits by itself.
      const open = await openLive(doc.port, token, { id: 6, key: doc.key });
      expect(await open.lines(1)).toHaveLength(1);
      child.process.kill("SIGINT");
      const exit = await child.exit;
      await open.ended();
      expect(exit.code).toBe(0);
      expect(exit.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(exit.stderr).toBe("");
      expect(exit.stdout).not.toContain(machine.root);
    });

    it("does not wait for an open connection: exits with 0 on SIGINT while a request is half sent", async () => {
      const child = startChild([
        "open",
        "--no-browser",
        "--json",
        "--config-dir",
        machine.configDir,
      ]);
      const doc = JSON.parse(await child.firstLine) as { port: number };
      const socket = connect({ host: "127.0.0.1", port: doc.port });
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      socket.on("error", () => undefined);
      socket.write(`POST /api/live HTTP/1.1\r\nHost: 127.0.0.1:${doc.port}\r\n`);
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      child.process.kill("SIGINT");
      expect((await child.exit).code).toBe(0);
      await closed;
    });
  },
);
