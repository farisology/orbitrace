import type { ReplayModel } from "@orbitrace/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrreryHandle, OrreryOptions } from "../src/api.js";
import { computeLayout } from "../src/layout.js";
import { browserEnvironment, createOrrery, createOrreryWithEnvironment } from "../src/orrery.js";
import { buildScene } from "../src/scene.js";
import { FakeCanvas, FakeEnvironment } from "./support/mock-context.js";
import { emptyModel, smallModel } from "./support/models.js";

function setup(options: OrreryOptions = {}, reduced = false) {
  const canvas = new FakeCanvas(1000, 800);
  const env = new FakeEnvironment(reduced, 2);
  const handle = createOrreryWithEnvironment(canvas.asCanvas(), options, env);
  return { canvas, env, handle };
}

/** Where agent `index` of the small model sits on a 1000 by 800 canvas. */
function positionOf(index: number) {
  const layout = computeLayout(buildScene(smallModel()), 1000, 800);
  return { clientX: layout.x[index]!, clientY: layout.y[index]! };
}

describe("createOrreryWithEnvironment", () => {
  it("sizes the backing store with the pixel ratio and draws an empty frame", () => {
    const { canvas, env } = setup();
    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(1600);
    expect(env.flush()).toBe(1);
    expect(canvas.context.count("fillRect")).toBe(1);
  });

  it("uses the devicePixelRatio option over the environment", () => {
    const { canvas } = setup({ devicePixelRatio: 1 });
    expect(canvas.width).toBe(1000);
    expect(() => setup({ devicePixelRatio: 0 })).toThrow(RangeError);
  });

  it("throws when the canvas has no 2D context", () => {
    const canvas = new FakeCanvas();
    canvas.getContext = () => null;
    expect(() =>
      createOrreryWithEnvironment(canvas.asCanvas(), {}, new FakeEnvironment()),
    ).toThrow();
  });

  it("draws once per change while paused and never runs its own loop", () => {
    const { env, handle } = setup();
    env.flush();
    handle.setModel(smallModel());
    handle.setTime(10);
    handle.setTime(20);
    expect(env.pending).toBe(1);
    expect(env.flush()).toBe(1);
    expect(env.pending).toBe(0);
  });

  it("schedules frames continuously while playing and stops on pause", () => {
    const { env, handle } = setup();
    handle.setModel(smallModel());
    handle.play();
    env.flush();
    expect(env.pending).toBe(1);
    env.flush();
    expect(env.pending).toBe(1);
    handle.pause();
    env.flush();
    expect(env.pending).toBe(0);
  });

  it("never advances replay time itself", () => {
    const { canvas, env, handle } = setup({ reducedMotion: true });
    handle.setModel(smallModel());
    handle.setTime(30);
    handle.play();
    env.flush();
    const first = canvas.context.drawOps();
    canvas.context.clear();
    handle.setTime(30);
    env.flush(1000);
    // Same replay time, reduced motion: the second frame is identical to the first.
    expect(canvas.context.drawOps()).toEqual(first);
  });

  it("renders still frames with reduced motion and does not loop while playing", () => {
    const { canvas, env, handle } = setup({}, true);
    handle.setModel(smallModel());
    handle.setTime(42);
    handle.play();
    env.flush();
    expect(env.pending).toBe(0);
    const a = canvas.context.drawOps();
    canvas.context.clear();
    handle.setTime(42);
    env.flush(500);
    expect(canvas.context.drawOps()).toEqual(a);
  });

  it("animates ambient motion while playing without reduced motion", () => {
    const { canvas, env, handle } = setup({ reducedMotion: false });
    handle.setModel(smallModel());
    handle.setTime(42);
    handle.play();
    env.flush();
    env.flush();
    const a = canvas.context.ops;
    canvas.context.clear();
    env.flush(50);
    expect(canvas.context.ops).not.toEqual(a);
  });

  it("clamps time to the model's duration", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    handle.setTime(500);
    env.flush();
    const atEnd = canvas.context.drawOps();
    canvas.context.clear();
    handle.setTime(100);
    env.flush(0);
    expect(canvas.context.drawOps()).toEqual(atEnd);
    handle.setTime(Number.NaN);
    expect(env.pending).toBe(0);
  });

  it("rejects a speed that is not greater than 0", () => {
    const { handle } = setup();
    expect(() => handle.setSpeed(0)).toThrow(RangeError);
    expect(() => handle.setSpeed(-1)).toThrow(RangeError);
    expect(() => handle.setSpeed(Number.NaN)).toThrow(RangeError);
    expect(() => handle.setSpeed(8)).not.toThrow();
  });

  it("emits hover and select from pointer input; select() does not emit", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    handle.setTime(30);
    env.flush();
    const hover = vi.fn();
    const select = vi.fn();
    handle.on("hover", hover);
    const off = handle.on("select", select);

    canvas.dispatch("pointermove", positionOf(1));
    expect(hover).toHaveBeenLastCalledWith({ agentId: "a1" });
    expect(canvas.style.cursor).toBe("pointer");
    canvas.dispatch("pointermove", positionOf(1));
    expect(hover).toHaveBeenCalledTimes(1);
    canvas.dispatch("pointerleave", {});
    expect(hover).toHaveBeenLastCalledWith({ agentId: null });

    canvas.dispatch("click", positionOf(2));
    expect(select).toHaveBeenLastCalledWith({ agentId: "a2" });
    canvas.dispatch("click", { clientX: 1, clientY: 1 });
    expect(select).toHaveBeenLastCalledWith({ agentId: null });
    // a3 starts at 75, so at t=30 a click on its place hits nothing.
    canvas.dispatch("click", positionOf(3));
    expect(select).toHaveBeenLastCalledWith({ agentId: null });

    handle.select("a1");
    expect(select).toHaveBeenCalledTimes(3);
    off();
    canvas.dispatch("click", positionOf(1));
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("highlights the selected agent", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    handle.setTime(62);
    env.flush();
    expect(canvas.context.texts()).not.toContain("code-reviewer");
    handle.select("a1");
    env.flush();
    expect(canvas.context.texts()).toContain("code-reviewer");
  });

  it("setModel clears the selection; updateModel keeps it when the id still exists", () => {
    const { canvas, env, handle } = setup();
    const select = vi.fn();
    handle.on("select", select);
    handle.setModel(smallModel());
    handle.setTime(62);
    handle.select("a1");
    handle.updateModel(smallModel());
    canvas.context.clear();
    env.flush();
    expect(canvas.context.texts()).toContain("code-reviewer");

    handle.updateModel(emptyModel(100));
    canvas.context.clear();
    env.flush();
    expect(canvas.context.texts()).toEqual(["main"]);
    handle.updateModel(smallModel());
    canvas.context.clear();
    env.flush();
    expect(canvas.context.texts()).not.toContain("code-reviewer");
    expect(select).not.toHaveBeenCalled();

    handle.select("a1");
    handle.setModel(smallModel());
    canvas.context.clear();
    env.flush();
    expect(canvas.context.texts()).not.toContain("code-reviewer");
  });

  it("keeps the time on updateModel, clamped to the new duration", () => {
    const { canvas, env, handle } = setup({ reducedMotion: true });
    handle.setModel(smallModel());
    handle.setTime(95);
    handle.updateModel(emptyModel(10));
    env.flush();
    const clamped = canvas.context.drawOps();
    canvas.context.clear();
    handle.setTime(10);
    env.flush();
    expect(canvas.context.drawOps()).toEqual(clamped);
  });

  it("ignores selecting an id that is not in the model", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    handle.setTime(62);
    handle.select("a99");
    env.flush();
    expect(canvas.context.texts()).not.toContain("code-reviewer");
  });

  it("rejects a replay with an unknown format version and keeps the old one", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    expect(() =>
      handle.setModel({ ...smallModel(), formatVersion: 9 } as unknown as ReplayModel),
    ).toThrow(RangeError);
    handle.setTime(62);
    env.flush();
    expect(canvas.context.texts()).toContain("test-runner");
  });

  it("resizes the backing store and draws at once", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    env.flush();
    canvas.context.clear();
    handle.resize(400, 300);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(canvas.context.count("fillRect")).toBeGreaterThan(0);
    handle.resize(Number.NaN, 1);
    expect(canvas.width).toBe(800);
  });

  it("uses theme overrides", () => {
    const { canvas, env, handle } = setup({ theme: { background: "#010203" } });
    handle.setModel(smallModel());
    env.flush();
    expect(canvas.context.ops.find((o) => o.op === "fillRect")!.args[4]).toBe("#010203");
  });

  it("destroy cancels the frame, removes listeners and makes the handle inert", () => {
    const { canvas, env, handle } = setup();
    handle.setModel(smallModel());
    handle.play();
    const hover = vi.fn();
    handle.on("hover", hover);
    expect(canvas.listenerCount()).toBe(3);
    handle.destroy();
    expect(env.cancelled).toBe(1);
    expect(canvas.listenerCount()).toBe(0);
    handle.setTime(10);
    handle.play();
    handle.select("a1");
    handle.resize(10, 10);
    expect(env.pending).toBe(0);
    expect(handle.on("hover", hover)).toBeTypeOf("function");
    handle.destroy();
  });
});

describe("createOrrery in a browser-like global", () => {
  const original = { window: globalThis.window, document: globalThis.document };
  afterEach(() => {
    Object.assign(globalThis, original);
  });

  it("uses requestAnimationFrame, matchMedia and devicePixelRatio", () => {
    const frames: ((now: number) => void)[] = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: (now: number) => void) => frames.push(cb),
      cancelAnimationFrame: vi.fn(),
      matchMedia: () => ({ matches: true }),
      devicePixelRatio: 3,
    };
    const fakeDocument = {
      createElement: () => new FakeCanvas(1, 1),
    };
    Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
    const env = browserEnvironment();
    expect(env.prefersReducedMotion()).toBe(true);
    expect(env.devicePixelRatio()).toBe(3);
    expect(env.createSurface(4, 4)).not.toBeNull();

    const canvas = new FakeCanvas(100, 50);
    const handle: OrreryHandle = createOrrery(canvas.asCanvas());
    expect(canvas.width).toBe(300);
    expect(frames).toHaveLength(1);
    handle.setModel(smallModel());
    handle.play();
    frames.shift()!(16);
    // Reduced motion from matchMedia: no continuous loop.
    expect(frames).toHaveLength(0);
    handle.destroy();
  });
});
