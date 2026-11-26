// One set of display formatters for the renderer and the app (#86).
import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, formatDurationShort, formatTokens } from "../../src/index.js";

describe("formatTokens", () => {
  it("uses one precision rule for every unit", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(999.4)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(4241)).toBe("4.2k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(148_536)).toBe("149k");
    expect(formatTokens(150_000)).toBe("150k");
    expect(formatTokens(257_255)).toBe("257k");
    expect(formatTokens(2_517_192)).toBe("2.52M");
    expect(formatTokens(4_100_000)).toBe("4.10M");
    expect(formatTokens(250_000_000)).toBe("250M");
    expect(formatTokens(1_250_000_000)).toBe("1.25B");
    expect(formatTokens(250_000_000_000)).toBe("250B");
    expect(formatTokens(2_500_000_000_000)).toBe("2500B");
  });

  it("moves to the next unit when rounding reaches 100 or 1,000 of a unit", () => {
    expect(formatTokens(999.6)).toBe("1.0k");
    expect(formatTokens(99_960)).toBe("100k");
    expect(formatTokens(999_600)).toBe("1.00M");
    expect(formatTokens(99_996_000)).toBe("100M");
    expect(formatTokens(999_600_000)).toBe("1.00B");
  });

  it("counts negative and non-finite values as 0", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatClock", () => {
  it("reads whole seconds, rounded down", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7.9)).toBe("0:07");
    expect(formatClock(754)).toBe("12:34");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("formatDuration", () => {
  it("writes a length in words", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(533)).toBe("8 min 53 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(3720)).toBe("1 h 2 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(-3)).toBe("0 s");
    expect(formatDuration(Number.NaN)).toBe("0 s");
  });
});

describe("formatDurationShort", () => {
  it("writes the same length compactly", () => {
    expect(formatDurationShort(45)).toBe("45s");
    expect(formatDurationShort(185)).toBe("3m05s");
    expect(formatDurationShort(4020)).toBe("1h07m");
    expect(formatDurationShort(-3)).toBe("0s");
    expect(formatDurationShort(Number.NaN)).toBe("0s");
  });
});

describe("one rounding rule for clocks and lengths", () => {
  it("shows a length and the clock at its end as the same whole second", () => {
    const length = 1067.7;
    expect(formatClock(length)).toBe("17:47");
    expect(formatDuration(length)).toBe("17 min 47 s");
    expect(formatDurationShort(length)).toBe("17m47s");
    for (const seconds of [0.4, 0.6, 59.5, 59.99, 185.5, 3599.9, 4020.7]) {
      const whole = Math.floor(seconds);
      expect(formatClock(seconds)).toBe(formatClock(whole));
      expect(formatDuration(seconds)).toBe(formatDuration(whole));
      expect(formatDurationShort(seconds)).toBe(formatDurationShort(whole));
    }
  });
});
