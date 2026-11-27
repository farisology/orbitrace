/**
 * Proves the hot path (computeFrameState + drawFrame) keeps nothing it allocates per frame: no
 * object made per frame is still alive when sampling stops. Short-lived garbage is not covered;
 * see the limit at the end of this comment.
 *
 * Method: warm up so the JIT has optimised the code and every interned label exists, then
 * run thousands of frames under V8's sampling heap profiler and add up the bytes it
 * attributes to code in packages/renderer/src. The profiler samples on average every
 * SAMPLING_INTERVAL bytes allocated, so one 16-byte object kept per frame over FRAMES frames
 * (128 KB) cannot go unseen. The last tests are the control: they show the same measurement
 * catches a small per-frame allocation that is kept (each frame's array stays in a sink until
 * sampling stops) and names the function that made it.
 *
 * Total heap growth is not used: it moves with work V8 does off the JavaScript path, so it
 * is too noisy to prove zero.
 *
 * A failure prints the bytes per file and per allocating function (with its caller), and how
 * many samples they came from with the largest object (#158). A kept per-frame allocation shows
 * as many samples of one small size. A few samples of mixed sizes, from about a hundred bytes to a few
 * KB, are V8 compiling a function during the run: the profiler charges the optimised code and
 * its metadata to whatever JavaScript is running when the compile is installed, so the named
 * function need not be the one compiled. In #158 that was a helper called once per frame that
 * returns at once, which V8 optimises only after tens of thousands of calls; such a check
 * belongs in the caller, with the call made only when there is work to do.
 *
 * The warm-up also reads every export of every module the frame path loads (#214). Vitest runs
 * src and core through Vite's SSR transform, which turns each export into a getter on the
 * module's export object, `() => { try { return LABEL_BUDGET } catch {} }`, and each use of an
 * import in another module into a call of that getter. A getter read about once per frame (for
 * example `LABEL_BUDGET` in draw.ts, or a phase code of timeline.ts in label-layout.ts) reaches
 * V8's optimising compiler only after some 24,000 reads, which is inside the measured run: its
 * compile was charged to the src function running when it landed (`markObstacle`, `traceShape`,
 * or a getter of timeline.ts or lod.ts), usually a few hundred bytes, once 6,976 bytes, under
 * load on Node 26 (#214). The bundles the browser, the extension and the CLI load have no such
 * getters: a module reads an imported binding directly. So they are test runner code, optimised
 * before the frames are measured rather than counted in them.
 *
 * A limit of the method (#214): the profile holds only the sampled objects still alive when
 * sampling stops. An object a garbage collection frees during the run is dropped from it, so a
 * per-frame allocation is caught when it is kept (as in the control below), and can pass when it
 * dies young and a collection runs before the run ends.
 */

/// <reference types="vite/client" />
import { Session } from "node:inspector/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "@orbitrace/core";
import type { ReplayModel } from "@orbitrace/core";
import { scaledReplay } from "../demo/sessions.js";
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
  id: number;
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children: ProfileNode[];
}

interface ProfileSample {
  /** Size of the sampled object in bytes. */
  size: number;
  nodeId: number;
}

/** Bytes charged to one allocating function, and the samples behind them. */
interface FunctionBytes {
  url: string;
  bytes: number;
  samples: number;
  largest: number;
}

/** What the sampling profiler saw while a run executed. */
interface Sampled {
  /** Bytes per script URL. */
  byFile: Map<string, number>;
  /** Bytes per allocating function, keyed "function (file) <- caller (file)". */
  byFunction: Map<string, FunctionBytes>;
}

let session: Session;
beforeAll(() => {
  session = new Session();
  session.connect();
});
afterAll(() => {
  session.disconnect();
});

/** The part of a script URL from `packages/` on, so a report names no local folder. */
function shortUrl(url: string): string {
  const at = url.indexOf("/packages/");
  if (at >= 0) return url.slice(at + 1);
  const slash = url.lastIndexOf("/");
  return slash >= 0 ? url.slice(slash + 1) : url;
}

/**
 * A profile frame as "function (file)". No line: the profiler reports lines of the module as
 * Vitest transformed it, which do not match the source.
 */
function frameName(node: ProfileNode): string {
  const { functionName, url } = node.callFrame;
  return `${functionName || "(anonymous)"} (${shortUrl(url)})`;
}

/** Bytes the sampling profiler attributes to each file and function while `run` executes. */
async function sampledBytes(run: () => void): Promise<Sampled> {
  await session.post("HeapProfiler.startSampling", { samplingInterval: SAMPLING_INTERVAL });
  run();
  const { profile } = (await session.post("HeapProfiler.stopSampling")) as unknown as {
    profile: { head: ProfileNode; samples: ProfileSample[] };
  };
  const byFile = new Map<string, number>();
  const byFunction = new Map<string, FunctionBytes>();
  const byNode = new Map<number, FunctionBytes>();
  const walk = (node: ProfileNode, parent: ProfileNode | null): void => {
    if (node.selfSize > 0) {
      const url = node.callFrame.url;
      byFile.set(url, (byFile.get(url) ?? 0) + node.selfSize);
      const key = `${frameName(node)} <- ${parent ? frameName(parent) : "(root)"}`;
      let entry = byFunction.get(key);
      if (!entry) {
        entry = { url, bytes: 0, samples: 0, largest: 0 };
        byFunction.set(key, entry);
      }
      entry.bytes += node.selfSize;
      byNode.set(node.id, entry);
    }
    for (const child of node.children) walk(child, node);
  };
  walk(profile.head, null);
  for (const sample of profile.samples) {
    const entry = byNode.get(sample.nodeId);
    if (!entry) continue;
    entry.samples++;
    entry.largest = Math.max(entry.largest, sample.size);
  }
  return { byFile, byFunction };
}

function bytesIn(byFile: Map<string, number>, fragment: string): number {
  let total = 0;
  for (const [url, bytes] of byFile) if (url.includes(fragment)) total += bytes;
  return total;
}

/** Files the budget covers: the renderer's source, and core code on the hot path (toRealSeconds). */
const BUDGETED = ["/packages/renderer/src/", "/packages/core/"];

/**
 * The bytes sampled in the files matching `fragments` (by default the budgeted ones), per file
 * and then per allocating function with its caller, largest first. This is what a failure prints.
 */
function breakdown(sampled: Sampled, fragments = BUDGETED): string {
  const budgeted = (url: string) => fragments.some((fragment) => url.includes(fragment));
  const lines: string[] = [];
  const files = [...sampled.byFile].filter(([url]) => budgeted(url)).sort((a, b) => b[1] - a[1]);
  for (const [url, bytes] of files) lines.push(`  ${bytes} B  ${shortUrl(url)}`);
  const functions = [...sampled.byFunction]
    .filter(([, entry]) => budgeted(entry.url))
    .sort((a, b) => b[1].bytes - a[1].bytes);
  if (functions.length > 0) lines.push("  by function (allocating frame <- caller):");
  for (const [key, entry] of functions) {
    const samples = `${entry.samples} sample${entry.samples === 1 ? "" : "s"}`;
    lines.push(`    ${entry.bytes} B  ${key}  (${samples}, largest ${entry.largest} B)`);
  }
  return lines.length > 0 ? lines.join("\n") : "  nothing sampled in budgeted files";
}

/** Sessions from the fixtures generator through core's pipeline (#77): full detail, and LOD. */
const models = new Map<number, ReplayModel>();
beforeAll(async () => {
  for (const agents of [100, 500]) models.set(agents, await scaledReplay(agents));
});

/**
 * The export objects of every renderer src module and of core, as Vitest loaded them: the same
 * module instances, and so the same export getters, that the frame path reads.
 */
const LOADED_MODULES: readonly Record<string, unknown>[] = [
  ...Object.values(import.meta.glob<Record<string, unknown>>("../src/**/*.ts", { eager: true })),
  core,
];

/**
 * Reads of each export per warm-up pass: several times the roughly 24,000 reads after which a
 * getter was seen to be optimised.
 */
const EXPORT_READS = 100_000;

/**
 * Warm-up passes, with a pause after each. V8 optimises a getter in two steps, each compiled on
 * a background thread, and ignores further reads while a step is still compiling. Under load
 * that wait can outlast a whole pass, and the getter then left one pass half-optimised: its last
 * step landed in the measured run (#214). Each pause lets the compile threads finish, and the
 * next pass gives every getter the reads its next step needs.
 */
const EXPORT_PASSES = 4;
const EXPORT_PAUSE_MS = 50;

/**
 * Read every export of `modules` `reads` times, so V8 optimises each export getter Vitest's
 * transform made (see the top of this file) before the frames are measured. Returns how many
 * exports there were and how many reads returned a value.
 */
function warmExportGetters(
  modules: readonly Record<string, unknown>[],
  reads: number,
): { exports: number; defined: number } {
  let exports = 0;
  let defined = 0;
  for (const module of modules) {
    for (const name of Object.keys(module)) {
      exports++;
      for (let i = 0; i < reads; i++) if (module[name] !== undefined) defined++;
    }
  }
  return { exports, defined };
}

beforeAll(async () => {
  for (let pass = 0; pass < EXPORT_PASSES; pass++) {
    const { exports, defined } = warmExportGetters(LOADED_MODULES, EXPORT_READS);
    if (exports < 100 || defined === 0) {
      throw new Error(`the export warm-up read only ${exports} exports (${defined} defined reads)`);
    }
    await new Promise((resolve) => setTimeout(resolve, EXPORT_PAUSE_MS));
  }
});

function setup(agents: number, reducedMotion: boolean) {
  const scene = buildScene(models.get(agents)!);
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

describe.each([
  [100, false],
  [100, true],
  [500, false],
  [500, true],
])("hot path at %i agents with reducedMotion=%s", (agents, reduced) => {
  it(`allocates nothing in src over ${FRAMES} frames`, { timeout: 120_000 }, async () => {
    const { run, scene, flightsSeen } = setup(agents, reduced);
    expect(scene.totalTools).toBeGreaterThan(500);
    for (let i = 0; i < 3; i++) run();
    expect(flightsSeen()).toBeGreaterThan(0);

    const sampled = await sampledBytes(run);
    let inSrc = 0;
    for (const fragment of BUDGETED) inSrc += bytesIn(sampled.byFile, fragment);
    const summary =
      `${agents} agents, reducedMotion=${reduced}: ${inSrc} bytes sampled in src over ${FRAMES} frames ` +
      `(${(inSrc / FRAMES).toFixed(3)} bytes/frame)`;
    console.log(inSrc > 0 ? `${summary}\n${breakdown(sampled)}` : summary);
    expect(inSrc, `${summary}, budget ${BUDGET_BYTES}\n${breakdown(sampled)}`).toBeLessThan(
      BUDGET_BYTES,
    );
  });
});

describe("allocation detector", () => {
  it("catches a 16-byte-per-frame allocation", async () => {
    const sink: (number[] | null)[] = new Array(FRAMES).fill(null);
    const leaky = () => {
      for (let k = 0; k < FRAMES; k++) sink[k] = [k];
    };
    leaky();
    const sampled = await sampledBytes(leaky);
    expect(bytesIn(sampled.byFile, "allocation.test.ts")).toBeGreaterThan(BUDGET_BYTES);
  });

  it("names the allocating function and its file in the report", async () => {
    const sink: (number[] | null)[] = new Array(FRAMES).fill(null);
    const leaky = () => {
      for (let k = 0; k < FRAMES; k++) sink[k] = [k];
    };
    leaky();
    const sampled = await sampledBytes(leaky);
    const report = breakdown(sampled, ["/packages/renderer/test/"]);
    expect(report).toMatch(/^ {2}\d+ B {2}packages\/renderer\/test\/allocation\.test\.ts$/m);
    // A kept per-frame allocation: many samples.
    const line =
      /^ {4}(\d+) B {2}leaky \(packages\/renderer\/test\/allocation\.test\.ts\) <- .* \((\d+) samples, largest (\d+) B\)$/m.exec(
        report,
      );
    expect(Number(line?.[1])).toBeGreaterThan(BUDGET_BYTES);
    expect(Number(line?.[2])).toBeGreaterThan(10);
    // Paths start at packages/: the folder above it never appears.
    expect(report).not.toMatch(/\/packages\//);
    // The budgeted files saw nothing of it.
    expect(breakdown(sampled)).toBe("  nothing sampled in budgeted files");
  });
});

describe("export getter warm-up (#214)", () => {
  it("covers the getters the frame path reads: Vitest serves each export through one", () => {
    const lod = LOADED_MODULES.find((module) => "LABEL_BUDGET" in module);
    expect(lod).toBeDefined();
    expect(typeof Object.getOwnPropertyDescriptor(lod, "LABEL_BUDGET")?.get).toBe("function");
    expect(LOADED_MODULES.some((module) => "PHASE_DONE" in module)).toBe(true);
    expect(typeof Object.getOwnPropertyDescriptor(core, "toRealSeconds")?.get).toBe("function");
  });

  it("reads every export the given number of times", () => {
    const reads = new Map<string, number>();
    const module: Record<string, unknown> = {};
    for (const name of ["first", "second", "missing"]) {
      Object.defineProperty(module, name, {
        enumerable: true,
        get: () => {
          reads.set(name, (reads.get(name) ?? 0) + 1);
          return name === "missing" ? undefined : name;
        },
      });
    }
    expect(warmExportGetters([module], 7)).toEqual({ exports: 3, defined: 14 });
    expect([...reads]).toEqual([
      ["first", 7],
      ["second", 7],
      ["missing", 7],
    ]);
  });
});
