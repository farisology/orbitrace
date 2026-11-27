/**
 * #118: the spawn flash and the idle-skip warp start at most three times in any one second of
 * real time (WCAG 2.3.1), at every playback speed up to 64x, also when many agents spawn
 * together. Checked two ways: on the schedule itself (by calculation), and by sampling frames
 * at 60 per real second through computeFrameState and counting the frames where a flash starts.
 */

import type { ReplayModel } from "@orbitrace/core";
import { beforeAll, describe, expect, it } from "vitest";
import { scaledReplay } from "../demo/sessions.js";
import {
  FLASH_MERGE_SECONDS,
  FLASH_MIN_GAP_SECONDS,
  MAX_FLASHES_PER_SECOND,
  createFlashSchedule,
  maxOnsetsInWindow,
  scheduleFlashes,
} from "../src/flash.js";
import { buildScene, type Scene } from "../src/scene.js";
import { EFFECT_SECONDS, computeFrameState, createFrameState } from "../src/timeline.js";
import { DEMO_GOLDEN } from "./support/golden.js";
import { call, mainAgent, model, smallModel, sub } from "./support/models.js";

/** Playback rates the app offers go up to 64x. */
const SPEEDS = [1, 2, 4, 8, 16, 32, 64];

/**
 * Invented stress session: 60 subagents spawning half a replay second apart (about 128 per real
 * second at 64x), in bursts, and 20 idle skips 10 replay seconds apart.
 */
function stressModel(): ReplayModel {
  const subs = Array.from({ length: 60 }, (_, k) =>
    sub({
      id: `a${k + 1}`,
      name: `widget-${k + 1}`,
      family: "haiku",
      effort: "low",
      wave: Math.floor(k / 15),
      start: 5 + k * 0.5 + (k % 3) * 0.01,
      end: 400,
      tools: [call("Read", "read", 6 + k * 0.5, 7 + k * 0.5)],
    }),
  );
  const warps = Array.from({ length: 20 }, (_, k) => ({ at: 40 + k * 10, skipped: 900 }));
  return model(mainAgent(500, [], []), subs, warps, 500);
}

const models = new Map<string, ReplayModel>();
beforeAll(async () => {
  models.set("demo", DEMO_GOLDEN);
  models.set("small", smallModel());
  models.set("stress", stressModel());
  models.set("100 agents", await scaledReplay(100));
  models.set("500 agents", await scaledReplay(500));
});

/** Every flash onset of a scene at `speed`, if each agent and each warp flashed on its own. */
function naiveMaxPerSecond(scene: Scene, speed: number): number {
  const onsets = [
    ...scene.agents.filter((a) => !a.isMain).map((a) => a.start),
    ...Array.from(scene.warpAt),
  ].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < onsets.length; hi++) {
    while (onsets[hi]! - onsets[lo]! > speed) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/**
 * Sample frames 60 per real second at `speed` over the whole replay and return the most
 * frames, in any one real second, in which a spawn flash or a warp starts.
 */
function sampledMaxPerSecond(scene: Scene, speed: number): { max: number; total: number } {
  const frame = createFrameState(scene);
  const timing = { speed, minVisibleCallSeconds: 0.3, reducedMotion: false };
  const fps = 60;
  const step = speed / fps;
  const prevSpawn = new Float32Array(scene.agents.length).fill(-1);
  let prevWarp = -1;
  const onsetFrames: number[] = [];
  const frames = Math.ceil(scene.duration / step) + 1;
  for (let k = 0; k <= frames; k++) {
    computeFrameState(scene, Math.min(scene.duration, k * step), timing, frame);
    let onset = false;
    for (let i = 0; i < scene.agents.length; i++) {
      const s = frame.spawn[i]!;
      // A flash starts when it appears, or restarts (progress goes back down).
      if (s >= 0 && (prevSpawn[i]! < 0 || s < prevSpawn[i]!)) onset = true;
      prevSpawn[i] = s;
    }
    if (frame.warpIndex >= 0 && frame.warpIndex !== prevWarp) onset = true;
    prevWarp = frame.warpIndex;
    if (onset) onsetFrames.push(k);
  }
  let max = 0;
  let lo = 0;
  for (let hi = 0; hi < onsetFrames.length; hi++) {
    while (onsetFrames[hi]! - onsetFrames[lo]! > fps) lo++;
    max = Math.max(max, hi - lo + 1);
  }
  return { max, total: onsetFrames.length };
}

describe("flash schedule", () => {
  it("orders agents by start and warps by time", () => {
    const schedule = createFlashSchedule([0, 30, 10, 10, 5], [50, 20]);
    expect(Array.from(schedule.spawnOrder)).toEqual([4, 2, 3, 1]);
    expect(Array.from(schedule.warpOrder)).toEqual([1, 0]);
    expect(Number.isNaN(schedule.speed)).toBe(true);
  });

  it("merges a burst into one onset at its last spawn and drops spawns inside the gap", () => {
    // At 1x: 10, 10.1, 10.2 merge (within 0.25 s of 10); 10.3 is outside the merge window but
    // inside the 0.35 s gap after the burst's onset at 10.2, so it does not flash; 11 does.
    const schedule = createFlashSchedule([0, 10, 10.1, 10.2, 10.3, 11], []);
    scheduleFlashes(schedule, 1, EFFECT_SECONDS.warp);
    expect(Array.from(schedule.spawnAt)).toEqual([NaN, 10.2, 10.2, 10.2, NaN, 11]);
    expect(Array.from(schedule.onsets.subarray(0, schedule.onsetCount))).toEqual([10.2, 11]);
  });

  it("shows warps that do not overlap and keeps bursts clear of them", () => {
    // Warp length 1.6 s at 1x: the warp at 21 starts inside the one at 20 and is not shown.
    const schedule = createFlashSchedule([0, 19.8, 25], [20, 21, 22]);
    scheduleFlashes(schedule, 1, 1.6);
    expect(Array.from(schedule.warpShown)).toEqual([1, 0, 1]);
    // 19.8 is 0.2 s before the warp at 20: no flash. 25 is clear.
    expect(Number.isNaN(schedule.spawnAt[1]!)).toBe(true);
    expect(schedule.spawnAt[2]).toBe(25);
  });

  it("scales its gaps with the speed and recomputes only when the speed changes", () => {
    const schedule = createFlashSchedule([0, 10, 12], []);
    scheduleFlashes(schedule, 1, 1.6);
    expect(schedule.onsetCount).toBe(2);
    // At 64x, 2 replay seconds are 0.03 real seconds: one burst.
    scheduleFlashes(schedule, 64, 1.6);
    expect(schedule.speed).toBe(64);
    expect(schedule.onsetCount).toBe(1);
    expect([schedule.spawnAt[1], schedule.spawnAt[2]]).toEqual([12, 12]);
    schedule.onsetCount = 99;
    scheduleFlashes(schedule, 64, 1.6);
    expect(schedule.onsetCount).toBe(99);
  });

  it("counts the most onsets in a window", () => {
    const schedule = createFlashSchedule([0, 1, 2, 3, 3.5], []);
    scheduleFlashes(schedule, 1, 1.6);
    expect(maxOnsetsInWindow(schedule, 1)).toBe(2);
    expect(maxOnsetsInWindow(schedule, 3)).toBe(4);
  });

  it("keeps three flashes a second by calculation: three gaps do not fit in one second", () => {
    expect(FLASH_MIN_GAP_SECONDS * MAX_FLASHES_PER_SECOND).toBeGreaterThan(1);
    expect(FLASH_MERGE_SECONDS).toBeLessThan(EFFECT_SECONDS.spawn);
  });
});

describe("flash rate at every playback speed (#118)", () => {
  it("never starts more than three flashes in any second, by the schedule", () => {
    for (const [name, m] of models) {
      const scene = buildScene(m);
      for (const speed of SPEEDS) {
        scheduleFlashes(scene.flashes, speed, EFFECT_SECONDS.warp);
        expect([name, speed, maxOnsetsInWindow(scene.flashes) <= MAX_FLASHES_PER_SECOND]).toEqual([
          name,
          speed,
          true,
        ]);
        // Consecutive onsets are at least the gap apart, in real seconds.
        const onsets = scene.flashes.onsets;
        for (let k = 1; k < scene.flashes.onsetCount; k++) {
          expect((onsets[k]! - onsets[k - 1]!) / speed).toBeGreaterThanOrEqual(
            FLASH_MIN_GAP_SECONDS - 1e-9,
          );
        }
      }
    }
  });

  it(
    "never starts more than three flashes in any second, in frames sampled at 60 fps",
    {
      timeout: 120_000,
    },
    () => {
      const counts: string[] = [];
      for (const [name, m] of models) {
        const scene = buildScene(m);
        // 1x over a whole scaled replay is many frames; the rule is the same in real seconds.
        const speeds = scene.agents.length > 20 && name !== "stress" ? [8, 64] : [1, 8, 64];
        for (const speed of speeds) {
          const { max, total } = sampledMaxPerSecond(scene, speed);
          counts.push(`${name} ${speed}x: ${total} onsets, at most ${max} in a second`);
          expect([name, speed, max <= MAX_FLASHES_PER_SECOND]).toEqual([name, speed, true]);
        }
      }
      console.log(counts.join("\n"));
    },
  );

  it("would exceed the limit without the schedule, so the cap is doing work", () => {
    for (const name of ["stress", "500 agents"]) {
      const scene = buildScene(models.get(name)!);
      expect(naiveMaxPerSecond(scene, 64)).toBeGreaterThan(MAX_FLASHES_PER_SECOND);
    }
  });

  it("still flashes: a burst of spawns gets one flash and warps still show", () => {
    const scene = buildScene(models.get("stress")!);
    const { total } = sampledMaxPerSecond(scene, 64);
    expect(total).toBeGreaterThan(0);
    const demo = buildScene(DEMO_GOLDEN);
    scheduleFlashes(demo.flashes, 1, EFFECT_SECONDS.warp);
    expect(Array.from(demo.flashes.warpShown).every((v) => v === 1)).toBe(true);
    // At 1x every demo agent that spawned on its own keeps its flash.
    const flashing = demo.agents.filter(
      (a) => !a.isMain && !Number.isNaN(demo.flashes.spawnAt[a.index]!),
    );
    expect(flashing.length).toBeGreaterThan(0);
  });

  it("starts each flash no earlier than its agent appears", () => {
    for (const [, m] of models) {
      const scene = buildScene(m);
      scheduleFlashes(scene.flashes, 64, EFFECT_SECONDS.warp);
      for (const a of scene.agents) {
        const at = scene.flashes.spawnAt[a.index]!;
        if (Number.isNaN(at)) continue;
        expect(at).toBeGreaterThanOrEqual(a.start);
        expect(at - a.start).toBeLessThanOrEqual(FLASH_MERGE_SECONDS * 64 + 1e-9);
      }
    }
  });

  it("has no flash at all with reduced motion", () => {
    const scene = buildScene(models.get("stress")!);
    const frame = createFrameState(scene);
    for (let t = 0; t < scene.duration; t += 0.25) {
      computeFrameState(
        scene,
        t,
        { speed: 64, minVisibleCallSeconds: 0.3, reducedMotion: true },
        frame,
      );
      expect(frame.warpIndex).toBe(-1);
      expect(frame.spawn.every((v) => v === -1)).toBe(true);
    }
  });
});
