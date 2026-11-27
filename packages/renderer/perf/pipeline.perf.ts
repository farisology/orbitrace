/**
 * Parse and build benchmark: how long core's `parseSession` and `buildReplay` take, and how much
 * memory they use, on synthetic sessions from the fixtures generator.
 *
 * 1. In memory, at 15, 100 and 500 agents: generate, parse, build.
 * 2. A transcript of about 50 MB: the generator writes it to a new temporary folder laid out
 *    like a Claude Code config folder, and a child process (scripts/parse-build-child.mjs) reads
 *    it back through the Claude Code adapter, `parseSession` and `buildReplay`, reporting time
 *    and peak memory. The folder is deleted afterwards; nothing is written to the repository.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReplay } from "@orbitrace/core";
import type { BuiltSession } from "@orbitrace/fixtures/generator";
import { describe, expect, it } from "vitest";
import {
  demoSession,
  parseGenerated,
  scaledSession,
  sessionBytes,
  type ScaledSessionOptions,
} from "../demo/sessions.js";

const TARGET_BYTES = 50 * 2 ** 20;
const CHILD = fileURLToPath(new URL("../scripts/parse-build-child.mjs", import.meta.url));
const MB = (bytes: number): number => Math.round((bytes / 2 ** 20) * 10) / 10;

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

async function timedAsync<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: Math.round((performance.now() - start) * 10) / 10 };
}

function machine() {
  return {
    node: process.version,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
  };
}

describe("parse and build", () => {
  it("reports in-memory pipeline time at 15, 100 and 500 agents", async () => {
    const cases: Record<string, unknown>[] = [];
    for (const agents of [15, 100, 500]) {
      const generated = timed(() => (agents === 15 ? demoSession() : scaledSession(agents)));
      // Once to warm up the JIT, then the timed run.
      await parseGenerated(generated.value);
      const parsed = await timedAsync(() => parseGenerated(generated.value));
      const built = timed(() => buildReplay(parsed.value));
      cases.push({
        agents: built.value.agents.length,
        toolCalls: built.value.totals.toolCalls,
        lines: parsed.value.lines.total,
        transcriptMB: MB(sessionBytes(generated.value)),
        generateMs: generated.ms,
        parseMs: parsed.ms,
        buildMs: built.ms,
      });
      expect(built.value.agents).toHaveLength(agents);
    }
    console.log(JSON.stringify({ bench: "pipeline-memory", ...machine(), cases }, null, 2));
  });

  it("reports parse and build time and peak memory for a 50 MB transcript", () => {
    // Size the session: measure a small one, then scale the rounds per subagent to the target.
    const agents = 100;
    const probeRounds = 10;
    const probe = sessionBytes(scaledSession(agents, { rounds: [probeRounds, probeRounds] }));
    // 5% over the straight-line estimate: per-agent overhead does not grow with the rounds.
    const rounds = Math.ceil(((probeRounds * TARGET_BYTES) / probe) * 1.05);
    const options: ScaledSessionOptions = { rounds: [rounds, rounds], mainRounds: rounds };
    const generated = timed(() => scaledSession(agents, options));
    const session: BuiltSession = generated.value;
    const bytes = sessionBytes(session);

    const root = mkdtempSync(join(tmpdir(), "orbitrace-perf-"));
    try {
      for (const file of session.files) {
        const target = join(root, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }
      const runs = [0, 1, 2].map(() => {
        const out = execFileSync(process.execPath, [CHILD, root], { encoding: "utf8" });
        return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, number>;
      });
      const median = (key: string): number => {
        const values = runs.map((run) => run[key]!).sort((a, b) => a - b);
        return values[1]!;
      };
      const report = {
        bench: "pipeline-50mb",
        ...machine(),
        transcriptMB: MB(bytes),
        files: session.files.length,
        roundsPerAgent: rounds,
        generateMs: generated.ms,
        runs,
        medianOpenAndParseMs: median("openAndParseMs"),
        medianBuildMs: median("buildMs"),
        medianPeakRssMB: median("peakRssMB"),
      };
      console.log(JSON.stringify(report, null, 2));
      expect(bytes).toBeGreaterThanOrEqual(TARGET_BYTES * 0.9);
      expect(runs[0]!.agents).toBe(agents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
