/**
 * Browser benchmark for the demo page (open with `?bench=1`, or run `npm run bench:browser`).
 * Runs at 15, 100 and 500 agents, on sessions made by the fixtures generator and core's real
 * `parseSession` and `buildReplay` (demo/sessions.ts), never on hand-built replays (#77).
 *
 * 1. Engine cost: frames driven synchronously through an injected scheduler, timing
 *    computeFrameState + drawFrame + the canvas calls they make. Chrome may rasterise later,
 *    so this is the main-thread cost per frame, not the whole frame.
 * 2. Real frame rate: the normal `createOrrery` playing for a few seconds under
 *    requestAnimationFrame, with the host clock advancing time every frame. This includes
 *    rasterisation and compositing as the browser schedules them.
 */

import type { ReplayModel } from "@orbitrace/core";
import type { OrreryEnvironment } from "../src/index.js";
import { browserEnvironment, createOrrery, createOrreryWithEnvironment } from "../src/index.js";
import { demoReplay, scaledReplay } from "./sessions.js";

export interface EngineCost {
  readonly frames: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Index of the slowest frame among the timed ones. */
  readonly slowestFrame: number;
  /** JS heap growth over the timed frames, when the browser exposes precise memory info. */
  readonly heapGrowthBytes: number | null;
}

export interface FrameRate {
  readonly seconds: number;
  readonly frames: number;
  readonly fps: number;
  readonly p95IntervalMs: number;
  /** Intervals longer than 20 ms (a missed 60 Hz frame). */
  readonly longFrames: number;
  /** Indices of the long intervals, at most five, to tell start-up cost from steady state. */
  readonly longFrameIndices: readonly number[];
  readonly maxIntervalMs: number;
}

export interface BenchCase {
  readonly name: string;
  readonly agents: number;
  readonly toolCalls: number;
  readonly cost: EngineCost;
  readonly rate: FrameRate;
}

export interface BenchResult {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly cases: readonly BenchCase[];
}

const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

function usedHeap(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : null;
}

function engineCost(canvas: HTMLCanvasElement, model: ReplayModel, frames: number): EngineCost {
  let queued: ((now: number) => void) | null = null;
  const base = browserEnvironment();
  const env: OrreryEnvironment = {
    ...base,
    requestFrame: (callback) => {
      queued = callback;
      return 1;
    },
    cancelFrame: () => {
      queued = null;
    },
  };
  const handle = createOrreryWithEnvironment(canvas, { reducedMotion: false }, env);
  const rect = canvas.getBoundingClientRect();
  handle.resize(rect.width, rect.height);
  handle.setModel(model);
  handle.setSpeed(30);
  handle.play();
  const duration = model.totals.duration;
  const step = (now: number, t: number): number => {
    handle.setTime(t);
    const callback = queued;
    queued = null;
    const start = performance.now();
    callback?.(now);
    return performance.now() - start;
  };
  for (let k = 0; k < 240; k++) step(k * 16, (duration * k) / 240);
  const times: number[] = new Array(frames).fill(0);
  const heapBefore = usedHeap();
  for (let k = 0; k < frames; k++) times[k] = step(4000 + k * 16, (duration * k) / frames);
  const heapAfter = usedHeap();
  handle.destroy();
  const slowestFrame = times.indexOf(Math.max(...times));
  times.sort((a, b) => a - b);
  return {
    frames,
    medianMs: quantile(times, 0.5),
    p95Ms: quantile(times, 0.95),
    maxMs: times[times.length - 1] ?? 0,
    slowestFrame,
    heapGrowthBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
  };
}

function frameRate(
  canvas: HTMLCanvasElement,
  model: ReplayModel,
  seconds: number,
): Promise<FrameRate> {
  return new Promise((resolve) => {
    const handle = createOrrery(canvas, { reducedMotion: false });
    const rect = canvas.getBoundingClientRect();
    handle.resize(rect.width, rect.height);
    handle.setModel(model);
    const speed = model.totals.duration / seconds;
    handle.setSpeed(speed);
    handle.play();
    const intervals: number[] = [];
    let first = -1;
    let last = -1;
    const tick = (now: number) => {
      if (first < 0) first = now;
      if (last >= 0) intervals.push(now - last);
      last = now;
      handle.setTime(((now - first) / 1000) * speed);
      if (now - first < seconds * 1000) {
        requestAnimationFrame(tick);
        return;
      }
      handle.destroy();
      const elapsed = (last - first) / 1000;
      const sorted = [...intervals].sort((a, b) => a - b);
      resolve({
        seconds: elapsed,
        frames: intervals.length,
        fps: elapsed > 0 ? intervals.length / elapsed : 0,
        p95IntervalMs: quantile(sorted, 0.95),
        longFrames: intervals.filter((i) => i > 20).length,
        longFrameIndices: intervals.flatMap((v, i) => (v > 20 ? [i] : [])).slice(0, 5),
        maxIntervalMs: sorted[sorted.length - 1] ?? 0,
      });
    };
    requestAnimationFrame(tick);
  });
}

/** Agent counts the benchmark runs at (#14): the demo session, and two scaled sessions. */
export const BENCH_AGENTS = [15, 100, 500] as const;

/** A session of `agents` agents, made by the fixtures generator and core's real pipeline. */
export function benchModel(agents: number): Promise<ReplayModel> {
  return agents === 15 ? demoReplay() : scaledReplay(agents);
}

export async function runBenchmark(
  canvas: HTMLCanvasElement,
  agentCounts: readonly number[] = BENCH_AGENTS,
): Promise<BenchResult> {
  const results: BenchCase[] = [];
  for (const agents of agentCounts) {
    const model = await benchModel(agents);
    const cost = engineCost(canvas, model, 600);
    const rate = await frameRate(canvas, model, 5);
    results.push({
      name: agents === 15 ? "demo session (15 agents)" : `scaled session (${agents} agents)`,
      agents: model.agents.length,
      toolCalls: model.totals.toolCalls,
      cost,
      rate,
    });
  }
  const rect = canvas.getBoundingClientRect();
  return {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    devicePixelRatio: window.devicePixelRatio,
    cases: results,
  };
}
