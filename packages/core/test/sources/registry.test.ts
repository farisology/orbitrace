// The optional live registry. In-memory file system; pids, session ids and folders are invented.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_LIVE_REGISTRY,
  isProcessAlive,
  liveStatusOf,
  readLiveRegistry,
  registryTime,
} from "../../src/sources/node.js";
import { createMemFs } from "./helpers/mem-fs.js";

const DIR = "/srv/example-cfg/sessions";

describe("registryTime", () => {
  it("reads ISO strings and seconds or milliseconds", () => {
    expect(registryTime("2026-01-02T03:04:05.000Z")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(registryTime(1_700_000_000)).toBe(1_700_000_000_000);
    expect(registryTime(1_700_000_000_123)).toBe(1_700_000_000_123);
    expect(registryTime("1700000000")).toBe(1_700_000_000_000);
    expect(registryTime("1700000000.5")).toBe(1_700_000_000_500);
  });

  it("returns null for anything else", () => {
    for (const value of [
      undefined,
      null,
      "",
      "  ",
      "not a date",
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      {},
    ]) {
      expect(registryTime(value)).toBeNull();
    }
  });
});

describe("isProcessAlive", () => {
  it("is true for this process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("never signals a process group or an invalid id", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(isProcessAlive(pid)).toBe(false);
    }
  });

  it("is false for an id no process has", () => {
    // Above the largest process id on Linux (4194304) and macOS (99998).
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });
});

describe("readLiveRegistry", () => {
  it("is absent when the folder is missing", async () => {
    const registry = await readLiveRegistry(createMemFs("posix"), path.posix, DIR, () => true);
    expect(registry).toBe(EMPTY_LIVE_REGISTRY);
    expect(registry.present).toBe(false);
  });

  it("reads entries, skips bad files, and prefers a live, then newer, entry per session", async () => {
    const fs = createMemFs("posix")
      .file(
        `${DIR}/10.json`,
        JSON.stringify({ pid: 10, sessionId: "s-1", status: "idle", updatedAt: 100 }),
      )
      .file(
        `${DIR}/11.json`,
        JSON.stringify({ pid: 11, sessionId: "s-1", status: "busy", updatedAt: 200 }),
      )
      .file(
        `${DIR}/12.json`,
        JSON.stringify({ pid: 12, sessionId: "s-1", status: "busy", updatedAt: 999 }),
      )
      .file(
        `${DIR}/20.json`,
        JSON.stringify({
          sessionId: "s-2",
          status: "idle",
          statusUpdatedAt: "1970-01-01T00:00:05.000Z",
        }),
      )
      .file(`${DIR}/x.json`, JSON.stringify({ sessionId: "s-3", status: "busy" }))
      .file(`${DIR}/bad.json`, "{nope")
      .file(`${DIR}/arr.json`, "[]")
      .file(`${DIR}/noid.json`, JSON.stringify({ pid: 30 }))
      .file(`${DIR}/note.txt`, "ignored");
    const alive = new Set([10, 11, 20]);
    const registry = await readLiveRegistry(fs, path.posix, DIR, (pid) => alive.has(pid));
    expect(registry.present).toBe(true);
    expect([...registry.bySessionId.keys()].sort()).toEqual(["s-1", "s-2", "s-3"]);
    expect(registry.bySessionId.get("s-1")).toMatchObject({
      pid: 11,
      alive: true,
      updatedAt: 200_000,
    });
    expect(registry.bySessionId.get("s-2")).toMatchObject({
      pid: 20,
      alive: true,
      updatedAt: 5_000,
    });
    expect(registry.bySessionId.get("s-3")).toMatchObject({
      pid: null,
      alive: false,
      updatedAt: null,
    });
  });
});

describe("liveStatusOf", () => {
  const record = (status: unknown, alive: boolean) => ({
    entry: { status } as never,
    pid: 1,
    alive,
    updatedAt: null,
  });

  it("maps registry state to a live status", () => {
    const registry = {
      present: true,
      bySessionId: new Map([
        ["busy", record("busy", true)],
        ["idle", record("idle", true)],
        ["odd", record("thinking", true)],
        ["dead", record("busy", false)],
      ]),
    };
    expect(liveStatusOf(registry, "busy")).toBe("busy");
    expect(liveStatusOf(registry, "idle")).toBe("idle");
    expect(liveStatusOf(registry, "odd")).toBe("unknown");
    expect(liveStatusOf(registry, "dead")).toBe("ended");
    expect(liveStatusOf(registry, "missing")).toBe("ended");
    expect(liveStatusOf(EMPTY_LIVE_REGISTRY, "busy")).toBe("unknown");
  });
});
