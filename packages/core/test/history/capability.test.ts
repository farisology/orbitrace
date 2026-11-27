// The history store's capability check and its unavailable path (#25). Runs on every Node: on a
// Node without node:sqlite (Node 20 in CI) it checks the real unavailable path; elsewhere it
// starts a child Node with node:sqlite turned off (`--no-experimental-sqlite`) to check the same.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSqlite } from "../../src/history/engine.js";
import { historyCapability } from "../../src/sources/node.js";
import {
  DIST_MAIN_ENTRY,
  DIST_NODE_ENTRY,
  FIXTURES_DIR,
  SQLITE_AVAILABLE,
  fixtureSessions,
  requireDist,
  spawnNode,
  useSandbox,
  waitForExit,
} from "./helpers.js";

const sandbox = useSandbox();

describe("historyCapability", () => {
  it("reports unavailable with a reason when the module cannot be imported", async () => {
    const missing = Object.assign(new Error("No such built-in module"), {
      code: "ERR_UNKNOWN_BUILTIN_MODULE",
    });
    const result = await loadSqlite(() => Promise.reject(missing));
    expect(result.module).toBeNull();
    expect(result.capability).toEqual({
      available: false,
      engine: "node:sqlite",
      nodeVersion: process.version,
      reason: expect.stringContaining("no node:sqlite module") as unknown as string,
    });
  });

  it("reports unavailable when the module has no DatabaseSync", async () => {
    const result = await loadSqlite(() => Promise.resolve({}));
    expect(result.capability.available).toBe(false);
  });

  it("reports unavailable when the module cannot open a database", async () => {
    const broken = {
      DatabaseSync: class {
        constructor() {
          throw new Error("cannot open");
        }
      },
    };
    const result = await loadSqlite(() => Promise.resolve(broken));
    expect(result.capability.available).toBe(false);
  });

  it("matches what this Node can import", async () => {
    let importable: boolean;
    try {
      await import(/* @vite-ignore */ ["node", "sqlite"].join(":"));
      importable = true;
    } catch {
      importable = false;
    }
    const capability = await historyCapability();
    expect(capability.available).toBe(importable);
    expect(capability.available).toBe(SQLITE_AVAILABLE);
    // Version and FTS5 are reported only when available; elsewhere a reason is.
    const details = capability.available
      ? { version: capability.sqliteVersion, fts5: typeof capability.fts5 }
      : { version: "3.0.0", fts5: "boolean" };
    expect(details.version).toMatch(/^3\.\d+\.\d+$/);
    expect(details.fts5).toBe("boolean");
  });

  it("leaves the rest of core working where node:sqlite is missing, and writes nothing", async () => {
    requireDist();
    const box = sandbox();
    const demo = fixtureSessions().find((session) => session.name === "single-agent");
    if (demo === undefined) throw new Error("fixture missing");
    const script = `
        const core = await import(${JSON.stringify(pathToFileURL(DIST_NODE_ENTRY).href)});
        const main = await import(${JSON.stringify(pathToFileURL(DIST_MAIN_ENTRY).href)});
        const { readFileSync } = await import("node:fs");
        const capability = await core.historyCapability();
        let openCode = null;
        try { await core.openHistoryStore({ mode: "write" }); } catch (error) { openCode = error.code; }
        const lines = readFileSync(process.argv[1], "utf8").split("\\n");
        const parsed = await main.parseSession({ main: lines, subagents: [] });
        console.log(JSON.stringify({ capability, openCode, total: parsed.lines.total }));
      `;
    // Node 20 has no node:sqlite and no flag for it; later versions turn it off with the flag.
    const major = Number(process.versions.node.split(".")[0]);
    const flags = major >= 22 ? ["--no-experimental-sqlite"] : [];
    const child = spawnNode(script, [join(FIXTURES_DIR, demo.transcript)], flags);
    const { code, out, err } = await waitForExit(child);
    expect(err).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      capability: { available: boolean; reason: string };
      openCode: string;
      total: number;
    };
    expect(report.capability.available).toBe(false);
    expect(report.capability.reason).toMatch(/node:sqlite/);
    expect(report.openCode).toBe("unavailable");
    expect(report.total).toBeGreaterThan(0);
    expect(existsSync(box.data)).toBe(false);
    expect(existsSync(join(box.home, ".orbitrace"))).toBe(false);
  }, 20_000);
});

describe("importing the history module", () => {
  it("creates nothing and needs no explicit call to stay inert", async () => {
    const box = sandbox();
    await import("../../src/history/index.js");
    await import("../../src/history/worker.js");
    expect(existsSync(box.data)).toBe(false);
    expect(existsSync(join(box.home, ".orbitrace"))).toBe(false);
  });
});
