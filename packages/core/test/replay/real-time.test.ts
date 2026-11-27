// toRealSeconds (ticket #71) and its inverse toCompressedSeconds (#135): compressed replay time
// to real seconds and back. Invented warps, and the committed synthetic golden replays of
// @orbitrace/fixtures (read as files: core cannot depend on the fixtures package).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReplay,
  toCompressedSeconds,
  toRealSeconds,
  type ReplayModel,
  type ReplayWarp,
} from "../../src/index.js";
import { Timeline, cutsFromWarps } from "../../src/replay/timeline.js";
import { at, reply, run, session } from "./helpers.js";

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

/** Every golden replay the fixtures manifest lists, plus the hand-written one beside them. */
function goldenReplays(): { name: string; model: ReplayModel }[] {
  const manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as {
    goldenReplays: string[];
  };
  const files = [...manifest.goldenReplays, "replays/minimal.replay.json"];
  return files.map((file) => ({
    name: file,
    model: JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8")) as ReplayModel,
  }));
}

/** Every time value written in a replay. */
function timesOf(model: ReplayModel): number[] {
  const times = [0, model.totals.duration];
  for (const warp of model.warps) times.push(warp.at);
  for (const agent of model.agents) {
    times.push(agent.start);
    if (agent.end !== null) times.push(agent.end);
    for (const tool of agent.tools) {
      times.push(tool.start);
      if (tool.end !== null) times.push(tool.end);
    }
    for (const entry of agent.replies) times.push(entry.t);
  }
  return times;
}

describe("toRealSeconds", () => {
  const warps: readonly ReplayWarp[] = [
    { at: 10, skipped: 100 },
    { at: 20, skipped: 50 },
  ];

  it("adds skipped of every warp whose at is less than t", () => {
    expect(toRealSeconds(warps, 0)).toBe(0);
    expect(toRealSeconds(warps, 5)).toBe(5);
    expect(toRealSeconds(warps, 15)).toBe(115);
    expect(toRealSeconds(warps, 25)).toBe(175);
  });

  it("does not count a warp that sits exactly at t", () => {
    expect(toRealSeconds(warps, 10)).toBe(10);
    expect(toRealSeconds(warps, 20)).toBe(120);
  });

  it("returns t unchanged with no warps", () => {
    expect(toRealSeconds([], 42.5)).toBe(42.5);
  });

  it("does not depend on warp order", () => {
    expect(toRealSeconds([...warps].reverse(), 25)).toBe(175);
  });

  it("maps a built replay's duration to its realDuration", () => {
    // Busy around 0 s and 300 s, idle in between: the builder cuts one warp.
    const model = buildReplay(
      session(run([reply({ id: "msg-1", t: 0 }), reply({ id: "msg-2", t: 300 })], [])),
    );
    expect(model.warps.length).toBeGreaterThan(0);
    expect(toRealSeconds(model.warps, model.totals.duration)).toBe(model.totals.realDuration);
    // The second reply is at 300 s real time.
    const second = model.agents[0].replies[1];
    expect(second).toBeDefined();
    expect(toRealSeconds(model.warps, second?.t ?? 0)).toBeCloseTo((at(300) - at(0)) / 1000, 6);
  });
});

describe("toCompressedSeconds", () => {
  /** 600 s removed at compressed 30, 120 s removed at compressed 50. */
  const warps: readonly ReplayWarp[] = [
    { at: 30, skipped: 600 },
    { at: 50, skipped: 120 },
  ];

  it("subtracts the warps before a real time", () => {
    expect(toCompressedSeconds(warps, 0)).toBe(0);
    expect(toCompressedSeconds(warps, 12.5)).toBe(12.5);
    expect(toCompressedSeconds(warps, 640)).toBe(40);
    expect(toCompressedSeconds(warps, 800)).toBe(80);
  });

  it("maps a real time inside a removed range to that warp's at", () => {
    expect(toCompressedSeconds(warps, 30)).toBe(30);
    expect(toCompressedSeconds(warps, 31)).toBe(30);
    expect(toCompressedSeconds(warps, 629.9)).toBe(30);
    // The end of a removed range is the cut position too.
    expect(toCompressedSeconds(warps, 630)).toBe(30);
    expect(toCompressedSeconds(warps, 641)).toBe(41);
    // The second removed range is real 650 to 770.
    expect(toCompressedSeconds(warps, 650.001)).toBe(50);
    expect(toCompressedSeconds(warps, 700)).toBe(50);
    expect(toCompressedSeconds(warps, 769.999)).toBe(50);
  });

  it("is the identity with no warps", () => {
    expect(toCompressedSeconds([], 42.5)).toBe(42.5);
    expect(toCompressedSeconds([], 0.001)).toBe(0.001);
  });

  it("gives 0 for a non-finite or negative real time", () => {
    expect(toCompressedSeconds(warps, Number.NaN)).toBe(0);
    expect(toCompressedSeconds(warps, Number.POSITIVE_INFINITY)).toBe(0);
    expect(toCompressedSeconds(warps, Number.NEGATIVE_INFINITY)).toBe(0);
    expect(toCompressedSeconds(warps, -3)).toBe(0);
    expect(toCompressedSeconds([], -0.5)).toBe(0);
  });

  it("round-trips toRealSeconds exactly on invented warps", () => {
    const fractional: readonly ReplayWarp[] = [
      { at: 0.1, skipped: 0.2 },
      { at: 12.345, skipped: 600.5 },
      { at: 99.999, skipped: 84.27 },
      { at: 250.001, skipped: 2807.205 },
    ];
    const misses: number[] = [];
    for (let ms = 0; ms <= 400_000; ms += 1) {
      const t = ms / 1000;
      if (toCompressedSeconds(fractional, toRealSeconds(fractional, t)) !== t) misses.push(t);
    }
    expect(misses).toEqual([]);
    for (const t of [0, 1, 29.999, 30, 30.001, 42, 50, 50.5, 77]) {
      expect(toCompressedSeconds(warps, toRealSeconds(warps, t))).toBe(t);
    }
  });

  it("agrees with the builder's Timeline.compress", () => {
    const fractional: readonly ReplayWarp[] = [
      { at: 8.004, skipped: 41.002 },
      { at: 60.5, skipped: 300 },
    ];
    const timeline = new Timeline(cutsFromWarps(fractional));
    for (let ms = 0; ms <= 500_000; ms += 7) {
      expect(toCompressedSeconds(fractional, ms / 1000)).toBeCloseTo(
        timeline.compress(ms) / 1000,
        9,
      );
    }
  });

  it("round-trips every time of every golden replay, and every millisecond up to its end", () => {
    const goldens = goldenReplays();
    expect(goldens.length).toBeGreaterThanOrEqual(10);
    expect(goldens.some((golden) => golden.model.warps.length > 1)).toBe(true);
    for (const { name, model } of goldens) {
      const { warps: w } = model;
      const off = timesOf(model).filter((t) => toCompressedSeconds(w, toRealSeconds(w, t)) !== t);
      expect({ name, off }).toEqual({ name, off: [] });
      const end = Math.round(model.totals.duration * 1000);
      const misses: number[] = [];
      for (let ms = 0; ms <= end; ms += 1) {
        const t = ms / 1000;
        if (toCompressedSeconds(w, toRealSeconds(w, t)) !== t) misses.push(t);
      }
      expect({ name, misses }).toEqual({ name, misses: [] });
      expect(toCompressedSeconds(w, model.totals.realDuration)).toBe(model.totals.duration);
    }
  });
});
