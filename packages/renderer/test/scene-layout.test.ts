import type { ReplayModel } from "@orbitrace/core";
import { describe, expect, it } from "vitest";
import {
  INNER_ORBIT,
  OUTER_RATIO,
  SINGLE_ORBIT,
  WIDE_BREAKPOINT,
  computeLayout,
  createLayout,
  orbitAngle,
  orbitRadius,
} from "../src/layout.js";
import { assertSupportedModel, buildScene, hashString } from "../src/scene.js";
import { BUCKET_FAILURE, BUCKET_READ, BUCKET_SHELL } from "../src/theme.js";
import { emptyModel, smallModel } from "./support/models.js";

describe("buildScene", () => {
  const scene = buildScene(smallModel());

  it("indexes agents by id and counts waves", () => {
    expect(scene.agents.map((a) => a.id)).toEqual(["main", "a1", "a2", "a3", "a4"]);
    expect(scene.byId.get("a3")).toBe(3);
    expect(scene.waveCount).toBe(2);
    expect([...scene.waveSizes]).toEqual([2, 2]);
    expect(scene.agents.map((a) => a.waveSlot)).toEqual([0, 0, 1, 0, 1]);
    expect(scene.agents[0]!.wave).toBe(-1);
    expect(scene.totalTools).toBe(11);
    expect(scene.duration).toBe(100);
  });

  it("gives open calls the end of their agent, or Infinity while it runs", () => {
    const a1 = scene.agents[1]!;
    expect(a1.toolOpen[2]).toBe(1);
    expect(a1.toolEnd[2]).toBe(60);
    const main = scene.agents[0]!;
    expect(main.toolEnd[4]).toBe(100);
    expect(scene.agents[3]!.end).toBe(Infinity);
  });

  it("colours calls by kind and skips the main agent's agent calls", () => {
    const main = scene.agents[0]!;
    expect([...main.toolSkip]).toEqual([0, 1, 1, 0, 1, 1, 0]);
    expect(main.toolBucket[3]).toBe(BUCKET_FAILURE);
    const a1 = scene.agents[1]!;
    expect([...a1.toolBucket]).toEqual([BUCKET_READ, BUCKET_FAILURE, BUCKET_SHELL]);
    expect(a1.toolSkip.every((v) => v === 0)).toBe(true);
  });

  it("keeps cumulative output tokens and the largest agent total", () => {
    expect([...scene.agents[1]!.outputPrefix]).toEqual([0, 300, 700]);
    expect(scene.maxOutput).toBe(1000);
    expect(scene.agents[1]!.handback.text).toBe("+700");
  });

  it("draws unknown families as circles but keeps the family name in the label", () => {
    const a4 = scene.agents[4]!;
    expect(a4.shape.family).toBe("unknown");
    expect(a4.identity.text).toBe("gizmo · effort n/a");
    expect(a4.fill).toBe(0.25);
    expect(scene.agents[2]!.maxEffort).toBe(true);
    expect(scene.agents[1]!.identity.text).toBe("Sonnet · medium");
  });

  it("keeps each agent's longest spoke and a flash schedule (#118, #128)", () => {
    for (const a of scene.agents) {
      const lengths = Array.from(a.flareLength).filter((_, j) => a.toolSkip[j] === 0);
      expect(a.maxFlareLength).toBe(lengths.length > 0 ? Math.max(...lengths) : 0);
    }
    expect(Array.from(scene.flashes.starts)).toEqual(scene.agents.map((a) => a.start));
    expect(Array.from(scene.flashes.warpAt)).toEqual([66]);
  });

  it("makes warp labels", () => {
    expect(scene.warpLabel[0]!.text).toBe("IDLE SKIPPED 10m00s");
    expect([...scene.warpAt]).toEqual([66]);
  });

  it("rejects an unknown format version or a missing main agent", () => {
    const bad = { ...smallModel(), formatVersion: 2 } as unknown as ReplayModel;
    expect(() => buildScene(bad)).toThrow(RangeError);
    const noMain = { ...smallModel(), agents: [] } as unknown as ReplayModel;
    expect(() => assertSupportedModel(noMain)).toThrow(RangeError);
  });

  it("hashes strings deterministically", () => {
    expect(hashString("a1")).toBe(hashString("a1"));
    expect(hashString("a1")).not.toBe(hashString("a2"));
    expect(hashString("x")).toBeGreaterThanOrEqual(0);
  });

  it("places moons and spokes the same way every time", () => {
    const again = buildScene(smallModel());
    expect([...again.agents[1]!.flareAngle]).toEqual([...scene.agents[1]!.flareAngle]);
    expect([...again.agents[1]!.moonCos]).toEqual([...scene.agents[1]!.moonCos]);
  });
});

describe("layout", () => {
  const scene = buildScene(smallModel());

  it("puts the main agent in the centre and later waves further out", () => {
    const layout = computeLayout(scene, 1000, 800);
    expect(layout.x[0]).toBe(500);
    expect(layout.y[0]).toBe(400);
    expect(layout.wide).toBe(true);
    expect(layout.ringRadius[0]).toBeCloseTo(layout.base * INNER_ORBIT);
    expect(layout.ringRadius[1]).toBeCloseTo(layout.base);
    const dist = (i: number) => Math.hypot(layout.x[i]! - 500, layout.y[i]! - 400);
    expect(dist(1)).toBeCloseTo(layout.ringRadius[0]!);
    expect(dist(3)).toBeCloseTo(layout.ringRadius[1]!);
    expect(layout.ro[1]).toBeCloseTo(layout.r[1]! * OUTER_RATIO);
  });

  it("keeps every node inside the canvas", () => {
    for (const [w, h] of [
      [320, 480],
      [1280, 720],
      [2000, 400],
    ] as const) {
      const layout = computeLayout(scene, w, h);
      for (let i = 0; i < scene.agents.length; i++) {
        expect(layout.x[i]! - layout.ro[i]!).toBeGreaterThanOrEqual(0);
        expect(layout.x[i]! + layout.ro[i]!).toBeLessThanOrEqual(w);
        expect(layout.y[i]! - layout.ro[i]!).toBeGreaterThanOrEqual(0);
        expect(layout.y[i]! + layout.ro[i]!).toBeLessThanOrEqual(h);
      }
    }
  });

  it("uses smaller nodes below the wide breakpoint", () => {
    const narrow = computeLayout(scene, WIDE_BREAKPOINT, 800);
    expect(narrow.wide).toBe(false);
    expect(narrow.r[0]).toBe(16);
    expect(narrow.r[1]).toBeLessThanOrEqual(9);
  });

  it("offsets odd waves by half a step", () => {
    expect(orbitAngle(0, 4, 1) - orbitAngle(0, 4, 0)).toBeCloseTo(Math.PI / 4);
    expect(orbitAngle(1, 4, 0) - orbitAngle(0, 4, 0)).toBeCloseTo(Math.PI / 2);
  });

  it("spaces orbits between the inner orbit and the base", () => {
    expect(orbitRadius(0, 1, 100)).toBeCloseTo(100 * SINGLE_ORBIT);
    expect(orbitRadius(0, 3, 100)).toBeCloseTo(56);
    expect(orbitRadius(1, 3, 100)).toBeCloseTo(78);
    expect(orbitRadius(2, 3, 100)).toBeCloseTo(100);
  });

  it("reuses the layout it is given when the sizes match", () => {
    const layout = createLayout(scene.agents.length, scene.waveCount);
    expect(computeLayout(scene, 900, 700, layout)).toBe(layout);
    const other = buildScene(emptyModel());
    expect(computeLayout(other, 900, 700, layout)).not.toBe(layout);
  });

  it("shrinks nodes when a wave is crowded", () => {
    const many = smallModel();
    const crowded = buildScene({
      ...many,
      agents: [
        many.agents[0],
        ...Array.from({ length: 60 }, (_, k) => ({
          ...many.agents[1]!,
          id: `a${k + 1}` as const,
          callsign: `x#${k + 1}`,
        })),
      ],
    });
    const layout = computeLayout(crowded, 1200, 800);
    expect(layout.r[1]).toBeLessThan(12);
  });
});
