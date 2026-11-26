// toRealSeconds (ticket #71): compressed replay time to real seconds. Invented warps only.
import { describe, expect, it } from "vitest";
import { buildReplay, toRealSeconds, type ReplayWarp } from "../../src/index.js";
import { at, reply, run, session } from "./helpers.js";

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
