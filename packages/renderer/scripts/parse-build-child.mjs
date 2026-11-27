#!/usr/bin/env node
// Child process of perf/pipeline.perf.ts: reads one synthetic session from a config folder the
// benchmark wrote to a temporary folder, through the real host path (Claude Code adapter
// `listSessions` and `openSession`, then `parseSession`, then `buildReplay`), and prints the
// time and memory of each step as one JSON line. A separate process, so its peak memory is the
// pipeline's alone and not the benchmark's or the generator's.
//
//   node scripts/parse-build-child.mjs <synthetic config folder>
//
// Never point it at a real Claude Code config folder: the benchmark passes the folder it made.

import { buildReplay, parseSession } from "@orbitrace/core";
import { claudeCodeAdapter } from "@orbitrace/core/node";

const root = process.argv[2];
if (!root) {
  console.error("usage: parse-build-child.mjs <synthetic config folder>");
  process.exit(2);
}

const mb = (bytes) => Math.round((bytes / 2 ** 20) * 10) / 10;
const before = process.memoryUsage();
const refs = await claudeCodeAdapter.listSessions({
  runtime: claudeCodeAdapter.runtime,
  root,
  resolvedBy: "user-setting",
  available: true,
});
if (refs.length !== 1) throw new Error(`expected one session in the folder, found ${refs.length}`);

const t0 = performance.now();
const input = await claudeCodeAdapter.openSession(refs[0]);
const parsed = await parseSession(input);
const t1 = performance.now();
const afterParse = process.memoryUsage();
const model = buildReplay(parsed);
const t2 = performance.now();
const afterBuild = process.memoryUsage();
const usage = process.resourceUsage();

console.log(
  JSON.stringify({
    lines: parsed.lines.total,
    agents: model.agents.length,
    toolCalls: model.totals.toolCalls,
    openAndParseMs: Math.round(t1 - t0),
    buildMs: Math.round(t2 - t1),
    rssStartMB: mb(before.rss),
    rssAfterParseMB: mb(afterParse.rss),
    rssAfterBuildMB: mb(afterBuild.rss),
    heapUsedAfterParseMB: mb(afterParse.heapUsed),
    heapUsedAfterBuildMB: mb(afterBuild.heapUsed),
    // Node reports maxRSS in kilobytes on every platform.
    peakRssMB: mb(usage.maxRSS * 1024),
  }),
);
