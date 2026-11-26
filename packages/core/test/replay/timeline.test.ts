import { describe, expect, it } from "vitest";
import {
  Timeline,
  cutsFromWarps,
  findCuts,
  mergeIntervals,
  mergeLiveCuts,
} from "../../src/replay/timeline.js";

describe("mergeIntervals", () => {
  it("merges overlapping and touching spans in start order", () => {
    expect(
      mergeIntervals([
        { start: 50, end: 60 },
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 5, end: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 50, end: 60 },
    ]);
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("findCuts", () => {
  it("cuts leading, middle and trailing gaps longer than the threshold", () => {
    const cuts = findCuts(
      [
        { start: 100_000, end: 110_000 },
        { start: 200_000, end: 205_000 },
      ],
      300_000,
      45_000,
      8_000,
    );
    expect(cuts).toEqual([
      { start: 4_000, end: 96_000 },
      { start: 114_000, end: 196_000 },
      { start: 209_000, end: 296_000 },
    ]);
  });

  it("leaves gaps up to the threshold alone and clips busy spans to the timeline", () => {
    expect(
      findCuts(
        [
          { start: -5_000, end: 10_000 },
          { start: 55_000, end: 80_000 },
        ],
        70_000,
        45_000,
        8_000,
      ),
    ).toEqual([]);
  });

  it("splits an odd kept length so every value stays whole", () => {
    expect(findCuts([], 100, 10, 7)).toEqual([{ start: 3, end: 96 }]);
  });
});

describe("Timeline", () => {
  const timeline = new Timeline([
    { start: 10, end: 110 },
    { start: 200, end: 250 },
  ]);

  it("maps real time to compressed time", () => {
    expect(timeline.compress(0)).toBe(0);
    expect(timeline.compress(10)).toBe(10);
    expect(timeline.compress(60)).toBe(10);
    expect(timeline.compress(110)).toBe(10);
    expect(timeline.compress(150)).toBe(50);
    expect(timeline.compress(225)).toBe(100);
    expect(timeline.compress(300)).toBe(150);
  });

  it("reports warps and round-trips them to cuts", () => {
    const warps = timeline.warpsMs();
    expect(warps).toEqual([
      { at: 10, skipped: 100 },
      { at: 100, skipped: 50 },
    ]);
    const asSeconds = warps.map((w) => ({ at: w.at / 1000, skipped: w.skipped / 1000 }));
    expect(cutsFromWarps(asSeconds)).toEqual([
      { start: 10, end: 110 },
      { start: 200, end: 250 },
    ]);
  });
});

describe("mergeLiveCuts", () => {
  const kept = [
    { start: 10, end: 100 },
    { start: 200, end: 300 },
  ];

  it("keeps previous cuts and appends later fresh ones", () => {
    expect(
      mergeLiveCuts(kept, [
        { start: 12, end: 90 },
        { start: 400, end: 500 },
      ]),
    ).toEqual([...kept, { start: 400, end: 500 }]);
  });

  it("grows the last cut when a fresh cut starts at the same point", () => {
    expect(mergeLiveCuts(kept, [{ start: 200, end: 350 }])).toEqual([
      { start: 10, end: 100 },
      { start: 200, end: 350 },
    ]);
    expect(mergeLiveCuts(kept, [{ start: 200, end: 250 }])).toEqual(kept);
  });

  it("uses fresh cuts when there were none", () => {
    expect(mergeLiveCuts([], [{ start: 1, end: 2 }])).toEqual([{ start: 1, end: 2 }]);
  });
});
