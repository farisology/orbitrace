import { describe, expect, it } from "vitest";
import * as core from "@orbitrace/core";
import {
  formatAgo,
  formatClock,
  formatCount,
  formatDuration,
  formatTokens,
  plural,
} from "../src/format";

describe("format", () => {
  it("formats clock readings", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(754)).toBe("12:34");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("formats durations in words", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(533)).toBe("8 min 53 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(3720)).toBe("1 h 2 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(Number.NaN)).toBe("0 s");
  });

  it("formats token counts short", () => {
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(4241)).toBe("4.2k");
    expect(formatTokens(148_536)).toBe("149k");
    expect(formatTokens(2_517_192)).toBe("2.52M");
    expect(formatTokens(250_000_000)).toBe("250M");
    expect(formatTokens(-1)).toBe("0");
  });

  it("uses core's formatters, so the panels match the canvas (#86)", () => {
    expect(formatClock).toBe(core.formatClock);
    expect(formatDuration).toBe(core.formatDuration);
    expect(formatTokens).toBe(core.formatTokens);
    // The inspector's length and the timeline's end reading of one session agree.
    expect(formatDuration(1067.7)).toBe("17 min 47 s");
    expect(formatClock(1067.7)).toBe("17:47");
  });

  it("formats counts with separators", () => {
    expect(formatCount(2_517_192)).toBe("2,517,192");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(Number.NaN)).toBe("0");
  });

  it("pluralises", () => {
    expect(plural(1, "call")).toBe("1 call");
    expect(plural(3, "call")).toBe("3 calls");
    expect(plural(2, "child", "children")).toBe("2 children");
  });

  it("formats how long ago, the same in every locale", () => {
    const now = 100 * 24 * 60 * 60 * 1000;
    expect(formatAgo(now - 30_000, now)).toBe("just now");
    expect(formatAgo(now + 5_000, now)).toBe("just now");
    expect(formatAgo(now - 12 * 60_000, now)).toBe("12 min ago");
    expect(formatAgo(now - 3 * 60 * 60_000, now)).toBe("3 h ago");
    expect(formatAgo(now - 24 * 60 * 60_000, now)).toBe("1 day ago");
    expect(formatAgo(now - 50 * 24 * 60 * 60_000, now)).toBe("50 days ago");
    expect(formatAgo(Number.NaN, now)).toBe("just now");
  });
});
