// @vitest-environment node
// Where the timeline's lane list scrolls (#144). Pure; positions in pixels.

import { describe, expect, it } from "vitest";
import { isInView, newLaneScrollTop, revealScrollTop } from "../src/lane-scroll";

/** A 24 px lane at `index`, after the list's 4 px top padding. */
const lane = (index: number) => ({ top: 4 + index * 24, bottom: 4 + (index + 1) * 24 });

describe("isInView", () => {
  it("is true only for a span wholly inside the view", () => {
    const view = { scrollTop: 24, height: 72 };
    expect(isInView(view, { top: 24, bottom: 96 })).toBe(true);
    expect(isInView(view, { top: 23, bottom: 40 })).toBe(false);
    expect(isInView(view, { top: 80, bottom: 97 })).toBe(false);
  });
});

describe("revealScrollTop", () => {
  it("leaves a visible span alone", () => {
    expect(revealScrollTop({ scrollTop: 0, height: 100 }, lane(2))).toBeNull();
  });

  it("scrolls down just far enough to show a span below the view", () => {
    // Lane 5 ends at 148; a 100 px view must start at 48.
    expect(revealScrollTop({ scrollTop: 0, height: 100 }, lane(5))).toBe(48);
  });

  it("scrolls up to the top of a span above the view", () => {
    expect(revealScrollTop({ scrollTop: 120, height: 100 }, lane(1))).toBe(28);
  });

  it("aligns a span taller than the view to its top", () => {
    expect(revealScrollTop({ scrollTop: 0, height: 20 }, lane(3))).toBe(76);
  });

  it("does nothing when the list is not laid out (no height)", () => {
    expect(revealScrollTop({ scrollTop: 0, height: 0 }, lane(9))).toBeNull();
    expect(revealScrollTop({ scrollTop: 0, height: Number.NaN }, lane(9))).toBeNull();
  });

  it("never asks for a negative position", () => {
    expect(revealScrollTop({ scrollTop: 10, height: 20 }, { top: -5, bottom: 5 })).toBe(0);
  });
});

describe("newLaneScrollTop", () => {
  const view = { scrollTop: 0, height: 72 };

  it("shows a new lane below the view", () => {
    expect(newLaneScrollTop(view, lane(4))).toBe(lane(4).bottom - 72);
  });

  it("leaves the list alone when the new lane is visible", () => {
    expect(newLaneScrollTop(view, lane(1))).toBeNull();
  });

  it("does not push a lane that must stay visible out of view", () => {
    // The selected lane 0 is visible now; showing lane 4 would hide it.
    expect(newLaneScrollTop(view, lane(4), [lane(0)])).toBeNull();
    // Lane 2 stays visible after the move, so the move happens.
    expect(newLaneScrollTop(view, lane(3), [lane(2)])).toBe(lane(3).bottom - 72);
  });

  it("ignores a kept lane that is already out of view", () => {
    expect(newLaneScrollTop({ scrollTop: 100, height: 72 }, lane(7), [lane(0)])).toBe(
      lane(7).bottom - 72,
    );
  });
});
