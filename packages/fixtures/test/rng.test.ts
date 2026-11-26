import { describe, expect, it } from "vitest";
import { createRng, hashSeed } from "../src/index.js";

describe("hashSeed", () => {
  it("gives the same unsigned 32-bit number for the same text", () => {
    expect(hashSeed("orbitrace")).toBe(hashSeed("orbitrace"));
    expect(hashSeed("orbitrace")).not.toBe(hashSeed("orbitracf"));
    for (const text of ["", "a", "orbitrace", "a much longer seed with spaces"]) {
      const hash = hashSeed(text);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("matches the published FNV-1a values", () => {
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("a")).toBe(0xe40c292c);
  });
});

describe("createRng", () => {
  const draw = (seed: number | string, count = 50) => {
    const rng = createRng(seed);
    return Array.from({ length: count }, () => rng.next());
  };

  it("gives the same sequence for the same seed", () => {
    expect(draw("seed-a")).toEqual(draw("seed-a"));
    expect(draw(9)).toEqual(draw("9"));
  });

  it("gives another sequence for another seed", () => {
    expect(draw("seed-a")).not.toEqual(draw("seed-b"));
  });

  it("next() stays in [0, 1) and is not stuck", () => {
    const values = draw("range", 2000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(new Set(values).size).toBeGreaterThan(1990);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("int() covers both ends and rejects a bad range", () => {
    const rng = createRng("ints");
    const seen = new Set(Array.from({ length: 400 }, () => rng.int(3, 6)));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(rng.int(7, 7)).toBe(7);
    expect(() => rng.int(2, 1)).toThrow(RangeError);
    expect(() => rng.int(0.5, 2)).toThrow(RangeError);
  });

  it("pick() returns items of the list and rejects an empty list", () => {
    const rng = createRng("picks");
    const items = ["a", "b", "c"] as const;
    const seen = new Set(Array.from({ length: 200 }, () => rng.pick(items)));
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it("chance() follows the probability", () => {
    const rng = createRng("chances");
    expect(Array.from({ length: 50 }, () => rng.chance(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 50 }, () => rng.chance(1)).every(Boolean)).toBe(true);
    const hits = Array.from({ length: 4000 }, () => rng.chance(0.25)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(850);
    expect(hits).toBeLessThan(1150);
  });

  it("chars() draws from the alphabet only", () => {
    const rng = createRng("chars");
    const text = rng.chars(64, "abc");
    expect(text).toMatch(/^[abc]{64}$/);
    expect(rng.chars(0, "abc")).toBe("");
    expect(() => rng.chars(3, "")).toThrow(RangeError);
  });

  it("fork() depends on the key and the label, not on what was drawn before", () => {
    const fresh = createRng("parent");
    const used = createRng("parent");
    for (let index = 0; index < 17; index += 1) used.next();
    expect(used.fork("child").next()).toBe(fresh.fork("child").next());
    expect(fresh.fork("child").next()).not.toBe(fresh.fork("other").next());
    expect(fresh.fork("child").key).toBe("parent/child");
    expect(createRng("parent").key).toBe("parent");
  });
});
