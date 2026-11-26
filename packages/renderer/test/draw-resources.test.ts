import { formatDuration as formatDurationWords } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import { curvePoint, drawFrame, MAX_MOONS_PER_AGENT, type ViewState } from "../src/draw.js";
import { computeLayout, createLayout } from "../src/layout.js";
import {
  STAR_COUNT,
  STAR_STRIDE,
  createGlowSprite,
  createResources,
  createSprites,
  createStars,
  ensureGradients,
  seededRandom,
  waveLabel,
} from "../src/resources.js";
import { buildScene } from "../src/scene.js";
import { createPalette, DEFAULT_THEME, resolveTheme } from "../src/theme.js";
import { computeFrameState, createFrameState, type TimingParams } from "../src/timeline.js";
import { MockContext, MockGradient, mockSurfaces } from "./support/mock-context.js";
import { call, emptyModel, mainAgent, model, smallModel, sub } from "./support/models.js";

const timing = (over: Partial<TimingParams> = {}): TimingParams => ({
  speed: 1,
  minVisibleCallSeconds: 0.3,
  reducedMotion: false,
  ...over,
});

function render(options: {
  t: number;
  reduced?: boolean;
  ambient?: number;
  selected?: number;
  hovered?: number;
  width?: number;
  theme?: Parameters<typeof resolveTheme>[0];
  speed?: number;
  m?: ReturnType<typeof smallModel>;
}): MockContext {
  const scene = buildScene(options.m ?? smallModel());
  const layout = computeLayout(scene, options.width ?? 1000, 800);
  const frame = computeFrameState(
    scene,
    options.t,
    timing({ reducedMotion: options.reduced ?? false, speed: options.speed ?? 1 }),
    createFrameState(scene),
  );
  const res = createResources(mockSurfaces(), createPalette(resolveTheme(options.theme)));
  const view: ViewState = {
    selected: options.selected ?? -1,
    hovered: options.hovered ?? -1,
    ambient: options.ambient ?? 0,
    dpr: 2,
  };
  const ctx = new MockContext();
  drawFrame(ctx.asDrawContext(), scene, layout, frame, view, res);
  return ctx;
}

describe("drawFrame", () => {
  it("paints only the background when there is no model", () => {
    const ctx = new MockContext();
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    const layout = createLayout(0, 0);
    layout.width = 300;
    layout.height = 200;
    const frame = createFrameState({ agents: [], totalTools: 0 });
    drawFrame(
      ctx.asDrawContext(),
      null,
      layout,
      frame,
      { selected: -1, hovered: -1, ambient: 0, dpr: 1 },
      res,
    );
    expect(ctx.count("fillRect")).toBe(1);
    expect(ctx.ops.find((o) => o.op === "fillRect")!.args).toEqual([
      0,
      0,
      300,
      200,
      DEFAULT_THEME.background,
    ]);
  });

  it("scales by the device pixel ratio", () => {
    const ctx = render({ t: 30 });
    expect(ctx.ops[0]).toEqual({ op: "setTransform", args: [2, 0, 0, 2, 0, 0] });
  });

  it("is deterministic for the same inputs", () => {
    expect(render({ t: 42, ambient: 3 }).ops).toEqual(render({ t: 42, ambient: 3 }).ops);
  });

  it("draws a still frame with reduced motion: ambient time changes nothing", () => {
    const a = render({ t: 42, reduced: true, ambient: 0 });
    const b = render({ t: 42, reduced: true, ambient: 5 });
    expect(a.ops).toEqual(b.ops);
    expect(a.count("rotate")).toBe(0);
    // Without reduced motion, ambient time moves the stars and dashes.
    expect(render({ t: 42, ambient: 0 }).ops).not.toEqual(render({ t: 42, ambient: 5 }).ops);
  });

  it("labels running agents and hides finished ones unless selected", () => {
    const texts = render({ t: 62 }).texts();
    expect(texts).toContain("main");
    expect(texts).toContain("test-runner");
    expect(texts).not.toContain("code-reviewer");
    const selected = render({ t: 62, selected: 1 }).texts();
    expect(selected).toContain("code-reviewer");
    expect(selected).toContain("Sonnet · medium");
    expect(selected).toContain("1 failed");
  });

  it("rounds an agent's run time down, as the app's inspector does (#86)", () => {
    for (const [ran, canvas, words] of [
      [17.7, "17s", "17 s"],
      [59.6, "59s", "59 s"],
      [1067.7, "17m47s", "17 min 47 s"],
    ] as const) {
      const agent = sub({
        id: "a1",
        name: "example-agent",
        family: "sonnet",
        effort: "medium",
        wave: 0,
        start: 10,
        end: 10 + ran,
      });
      const end = 20 + ran;
      const m = model(mainAgent(end, [call("Agent", "agent", 9.5, 10.5 + ran)], []), [agent], [], end);
      const texts = render({ t: end, selected: 1, m }).texts();
      expect(texts).toContain(canvas);
      expect(formatDurationWords(ran)).toBe(words);
    }
  });

  it("does not draw agents that have not started", () => {
    const texts = render({ t: 30 }).texts();
    expect(texts).not.toContain("doc-writer");
  });

  it("draws the reticle on the selected agent", () => {
    const without = render({ t: 30 });
    const withSel = render({ t: 30, selected: 2 });
    expect(withSel.count("arc") - without.count("arc")).toBe(4);
  });

  it("colours failed moons with the theme's failure colour", () => {
    const ctx = render({ t: 30, theme: { failure: "#ABCDEF" } });
    expect(ctx.ops.some((o) => o.op === "fill" && o.args[0] === "#ABCDEF")).toBe(true);
  });

  it("colours a failing call by kind until its result is in", () => {
    // main's Bash call runs 66.5 to 70 and fails.
    const theme = { failure: "#ABCDEF", shell: "#FEDCBA" };
    const running = render({ t: 68, theme, reduced: true });
    const strokes = (ctx: MockContext, color: string) =>
      ctx.ops.filter((o) => o.op === "stroke" && o.args[0] === color).length;
    expect(strokes(running, "#FEDCBA")).toBeGreaterThan(0);
    expect(strokes(running, "#ABCDEF")).toBe(0);
    const ended = render({ t: 70.1, theme, speed: 10 });
    expect(strokes(ended, "#ABCDEF")).toBeGreaterThan(0);
  });

  it("draws the token arc from the top", () => {
    const ctx = render({ t: 30 });
    const arcs = ctx.ops.filter((o) => o.op === "arc" && o.args[3] === -Math.PI / 2);
    expect(arcs.length).toBeGreaterThan(0);
  });

  it("draws comets and the warp label at the right times", () => {
    const comet = render({ t: 9.8, speed: 1 });
    expect(comet.count("drawImage")).toBeGreaterThan(0);
    const warp = render({ t: 66.8 });
    expect(warp.texts()).toContain("IDLE SKIPPED 10m00s");
    const still = render({ t: 66.8, reduced: true });
    expect(still.texts()).not.toContain("IDLE SKIPPED 10m00s");
  });

  it("labels a long call in flight with its name and seconds", () => {
    // a1's open Bash call started at 20.
    const texts = render({ t: 32 }).texts();
    expect(texts).toContain("Bash");
    expect(texts).toContain("12s");
  });

  it("caps the moons drawn per agent", () => {
    const tools = Array.from({ length: MAX_MOONS_PER_AGENT + 50 }, (_, k) =>
      call("Read", "read", k * 0.1, k * 0.1 + 0.01),
    );
    const m = model(mainAgent(100, tools, []), [], [], 100);
    const ctx = render({ t: 99, m, reduced: true });
    const moonArcs = ctx.ops.filter((o) => o.op === "arc" && o.args[2] === 1.5).length;
    expect(moonArcs).toBe(MAX_MOONS_PER_AGENT);
  });

  it("draws an empty model without subagents", () => {
    const ctx = render({ t: 5, m: emptyModel() });
    expect(ctx.texts()).toEqual(["main"]);
  });
});

describe("curvePoint", () => {
  it("runs from the start to the end, bending to one side", () => {
    const out = new Float64Array(4);
    curvePoint(0, 0, 0, 100, 0, out);
    expect([out[0], out[1]]).toEqual([0, 0]);
    curvePoint(1, 0, 0, 100, 0, out);
    expect([out[0], out[1]]).toEqual([100, 0]);
    curvePoint(0.5, 0, 0, 100, 0, out);
    expect(out[1]).toBeCloseTo(8);
    expect(out[3]).toBeCloseTo(16);
  });
});

describe("resources", () => {
  it("makes deterministic random numbers and stars", () => {
    const a = seededRandom(5);
    const b = seededRandom(5);
    const values = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(values);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    const stars = createStars(STAR_COUNT);
    expect(stars.length).toBe(STAR_COUNT * STAR_STRIDE);
    expect([...createStars(10, 3)]).toEqual([...createStars(10, 3)]);
  });

  it("makes glow sprites, or none without surfaces", () => {
    const surfaces = mockSurfaces();
    const sprite = createGlowSprite(surfaces, "#FF0000", 10);
    expect(sprite?.radius).toBe(10);
    expect(createGlowSprite({ createSurface: () => null }, "#FF0000", 10)).toBeNull();
    expect(createSprites({ createSurface: () => null }, createPalette(DEFAULT_THEME))).toBeNull();
    const sprites = createSprites(surfaces, createPalette(DEFAULT_THEME));
    expect(sprites?.moon).toHaveLength(5);
  });

  it("rebuilds gradients only when the size changes", () => {
    const ctx = new MockContext();
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    ensureGradients(ctx.asDrawContext(), res, 800, 600, 400, 300, 200);
    const first = ctx.count("createRadialGradient");
    expect(first).toBe(4);
    ensureGradients(ctx.asDrawContext(), res, 800, 600, 400, 300, 200);
    expect(ctx.count("createRadialGradient")).toBe(first);
    expect(res.gradients.sweep).toBeInstanceOf(MockGradient);
    ensureGradients(ctx.asDrawContext(), res, 900, 600, 450, 300, 200);
    expect(ctx.count("createRadialGradient")).toBe(first * 2);
  });

  it("creates wave labels on first use", () => {
    const res = createResources(mockSurfaces(), createPalette(DEFAULT_THEME));
    expect(waveLabel(res, 2).text).toBe("WAVE 3");
    expect(waveLabel(res, 0).text).toBe("WAVE 1");
    expect(waveLabel(res, 2)).toBe(waveLabel(res, 2));
  });
});
