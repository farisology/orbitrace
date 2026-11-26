/**
 * Proves the hot path (computeFrameState + drawFrame) allocates nothing per frame.
 *
 * Method: warm up so the JIT has optimised the code and every interned label exists, then
 * run thousands of frames under V8's sampling heap profiler and add up the bytes it
 * attributes to code in packages/renderer/src. The profiler samples on average every
 * SAMPLING_INTERVAL bytes allocated, so one 16-byte object per frame over FRAMES frames
 * (128 KB) cannot go unseen. The last test is the control: it shows the same measurement
 * catches a small per-frame allocation.
 *
 * Total heap growth is not used: it moves with work V8 does off the JavaScript path, so it
 * is too noisy to prove zero.
 */

import { Session } from "node:inspector/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoModel } from "../demo/demo-model.js";
import { drawFrame, type ViewState } from "../src/draw.js";
import { computeLayout } from "../src/layout.js";
import { createResources } from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME } from "../src/theme.js";
import { computeFrameState, createFrameState } from "../src/timeline.js";
import { MockContext, mockSurfaces } from "./support/mock-context.js";

const FRAMES = 8000;
const SAMPLING_INTERVAL = 128;
/** Bytes allowed for the whole run: under one byte per frame. */
const BUDGET_BYTES = 4096;

interface ProfileNode {
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children: ProfileNode[];
}

let session: Session;
beforeAll(() => {
  session = new Session();
  session.connect();
});
afterAll(() => {
  session.disconnect();
});

/** Bytes the sampling profiler attributes to each source file while `run` executes. */
async function sampledBytes(run: () => void): Promise<Map<string, number>> {
  await session.post("HeapProfiler.startSampling", { samplingInterval: SAMPLING_INTERVAL });
  run();
  const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as {
    profile: { head: ProfileNode };
  };
  const byFile = new Map<string, number>();
  const walk = (node: ProfileNode): void => {
    if (node.selfSize > 0) {
      const url = node.callFrame.url;
      byFile.set(url, (byFile.get(url) ?? 0) + node.selfSize);
    }
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  return byFile;
}

function bytesIn(byFile: Map<string, number>, fragment: string): number {
  let total = 0;
  for (const [url, bytes] of byFile) if (url.includes(fragment)) total += bytes;
  return total;
}

function setup(reducedMotion: boolean) {
  const scene = buildScene(createDemoModel({ seed: 7, waves: 4, agentsPerWave: 8 }));
  const layout = computeLayout(scene, 1280, 800);
  const frame = createFrameState(scene);
  const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
  const ctx = new MockContext(false).asDrawContext();
  const view: ViewState = { selected: 3, hovered: 5, ambient: 0, dpr: 2 };
  const timing = { speed: 30, minVisibleCallSeconds: 0.3, reducedMotion };
  const step = scene.duration / FRAMES;
  let flights = 0;
  const run = () => {
    for (let k = 0; k < FRAMES; k++) {
      view.ambient = k / 60;
      computeFrameState(scene, k * step, timing, frame);
      flights += frame.flightCount;
      drawFrame(ctx, scene, layout, frame, view, res);
    }
  };
  return { run, scene, flightsSeen: () => flights };
}

describe.each([false, true])("hot path with reducedMotion=%s", (reduced) => {
  it(`allocates nothing in src over ${FRAMES} frames`, async () => {
    const { run, scene, flightsSeen } = setup(reduced);
    expect(scene.totalTools).toBeGreaterThan(500);
    for (let i = 0; i < 4; i++) run();
    expect(flightsSeen()).toBeGreaterThan(0);

    const byFile = await sampledBytes(run);
    // Core code on the hot path (toRealSeconds) counts against the same budget.
    const inSrc = bytesIn(byFile, "/packages/renderer/src/") + bytesIn(byFile, "/packages/core/");
    console.log(
      `reducedMotion=${reduced}: ${inSrc} bytes sampled in src over ${FRAMES} frames ` +
        `(${(inSrc / FRAMES).toFixed(3)} bytes/frame)`,
    );
    expect(inSrc).toBeLessThan(BUDGET_BYTES);
  });
});

describe("allocation detector", () => {
  it("catches a 16-byte-per-frame allocation", async () => {
    const sink: (number[] | null)[] = new Array(FRAMES).fill(null);
    const leaky = () => {
      for (let k = 0; k < FRAMES; k++) sink[k] = [k];
    };
    leaky();
    const byFile = await sampledBytes(leaky);
    expect(bytesIn(byFile, "allocation.test.ts")).toBeGreaterThan(BUDGET_BYTES);
  });
});
