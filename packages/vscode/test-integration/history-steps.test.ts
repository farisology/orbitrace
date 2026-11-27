// The history steps of the integration suite (#196), run here in plain Node against a real
// sandbox (`createSandbox`, synthetic sessions only) with the environment pointed into it, as the
// launcher does for the editor. On a Node without node:sqlite (Node 20) the store steps are
// skipped with the capability's reason, which is what this checks there.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { historyCapability, type HistoryCapability } from "@orbitrace/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHistorySteps,
  coreWorkerPath,
  countTranscripts,
  describeCapability,
} from "./history-steps.js";
import { createSandbox, removeSandbox, type SandboxDescription } from "./sandbox.js";
import { runSteps } from "./steps.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capability = await historyCapability();
const ENV_KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "ORBITRACE_DATA_DIR"] as const;

const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oti-test-")));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("countTranscripts", () => {
  it("counts .jsonl files under projects/ and their complete, non-blank lines", () => {
    const config = tempDir();
    const project = join(config, "projects", "-srv-example-project");
    mkdirSync(join(project, "session-a", "subagents"), { recursive: true });
    writeFileSync(join(project, "session-a.jsonl"), '{"n":1}\n\n{"n":2}\n{"n":3, "partial":');
    writeFileSync(join(project, "session-a", "subagents", "agent-x.jsonl"), '{"n":4}\r\n');
    writeFileSync(join(project, "session-a", "subagents", "agent-x.meta.json"), "{}\n");
    writeFileSync(join(config, "outside.jsonl"), '{"n":5}\n');
    expect(countTranscripts(config)).toEqual({ files: 2, lines: 3 });
  });

  it("is zero when there is no projects folder", () => {
    expect(countTranscripts(tempDir())).toEqual({ files: 0, lines: 0 });
  });
});

describe("coreWorkerPath", () => {
  it("finds the built worker entry of @orbitrace/core from this package", () => {
    const worker = coreWorkerPath(PACKAGE_DIR);
    expect(existsSync(worker)).toBe(true);
    expect(worker.split(/[\\/]/).slice(-2)).toEqual(["history", "worker.js"]);
  });

  it("says to build when the worker file is missing", () => {
    const pkg = tempDir();
    const core = join(pkg, "node_modules", "@orbitrace", "core");
    mkdirSync(join(core, "dist", "sources"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"example-host"}');
    writeFileSync(
      join(core, "package.json"),
      JSON.stringify({ name: "@orbitrace/core", exports: { "./node": "./dist/sources/node.js" } }),
    );
    writeFileSync(join(core, "dist", "sources", "node.js"), "");
    expect(() => coreWorkerPath(pkg)).toThrow(/npm run build/);
  });
});

describe("describeCapability", () => {
  it("gives the versions when available and the reason when not", () => {
    const available: HistoryCapability = {
      available: true,
      engine: "node:sqlite",
      nodeVersion: "v24.22.1",
      sqliteVersion: "3.53.4",
      fts5: false,
    };
    expect(describeCapability(available)).toBe(
      "available: node:sqlite in Node v24.22.1, SQLite 3.53.4, FTS5 no",
    );
    expect(
      describeCapability({
        available: false,
        engine: "node:sqlite",
        nodeVersion: "v20.18.1",
        reason: "no node:sqlite here",
      }),
    ).toBe("unavailable in Node v20.18.1: no node:sqlite here");
  });
});

describe(`buildHistorySteps (${describeCapability(capability)})`, () => {
  let sandbox: SandboxDescription | null = null;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    sandbox = createSandbox(tempDir());
    process.env["HOME"] = sandbox.homeDir;
    process.env["USERPROFILE"] = sandbox.homeDir;
    process.env["CLAUDE_CONFIG_DIR"] = sandbox.configDir;
    process.env["ORBITRACE_DATA_DIR"] = sandbox.historyDataDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (sandbox !== null) removeSandbox(sandbox);
    sandbox = null;
  });

  it("runs every step on the sandbox, or skips the store steps with the reason", async () => {
    const box = sandbox!;
    const lines: string[] = [];
    const report = await runSteps(
      buildHistorySteps({ sandbox: box, packageDir: PACKAGE_DIR, log: (l) => lines.push(l) }),
      { timeoutMs: 30_000 },
    );
    expect(report.failed).toBe(0);
    if (capability.available) {
      expect(report).toMatchObject({ passed: 6, skipped: 0 });
      expect(lines.some((l) => /\d+ sessions, \d+ files, \d+ lines/.test(l))).toBe(true);
    } else {
      expect(report).toMatchObject({ passed: 2, skipped: 4 });
      for (const result of report.results.slice(2)) {
        expect(result.skipReason).toBe(capability.reason);
      }
    }
    expect(existsSync(box.historyDataDir)).toBe(false);
    expect(lines.join("\n")).not.toContain(box.root);
  }, 60_000);

  it("stops at the first step when ORBITRACE_DATA_DIR points elsewhere, and writes nothing", async () => {
    const box = sandbox!;
    const elsewhere = join(box.root, "elsewhere");
    process.env["ORBITRACE_DATA_DIR"] = elsewhere;
    const report = await runSteps(
      buildHistorySteps({ sandbox: box, packageDir: PACKAGE_DIR, log: () => undefined }),
      { timeoutMs: 30_000 },
    );
    expect(report).toMatchObject({ passed: 0, failed: 1, skipped: 5 });
    expect(report.results[0]?.error).toMatch(/ORBITRACE_DATA_DIR/);
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(box.historyDataDir)).toBe(false);
  });
});
