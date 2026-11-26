import { describe, expect, it } from "vitest";
import {
  asArray,
  asBoolean,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asTokenCount,
  parseTimestamp,
} from "../../src/parser/values.js";

describe("value readers", () => {
  it("asRecord accepts plain objects only", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("x")).toBeNull();
  });

  it("asArray returns arrays and an empty array otherwise", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ length: 1 })).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });

  it("asNonEmptyString rejects empty strings and other types", () => {
    expect(asNonEmptyString("a")).toBe("a");
    expect(asNonEmptyString("")).toBeNull();
    expect(asNonEmptyString(1)).toBeNull();
  });

  it("asBoolean accepts booleans only", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean("true")).toBeNull();
  });

  it("asFiniteNumber rejects NaN, infinities and numeric strings", () => {
    expect(asFiniteNumber(2)).toBe(2);
    expect(asFiniteNumber(Number.NaN)).toBeNull();
    expect(asFiniteNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(asFiniteNumber("2")).toBeNull();
  });

  it("asTokenCount gives 0 for anything that is not a finite, non-negative number", () => {
    expect(asTokenCount(12)).toBe(12);
    expect(asTokenCount(0)).toBe(0);
    expect(asTokenCount(-3)).toBe(0);
    expect(asTokenCount("12")).toBe(0);
    expect(asTokenCount(undefined)).toBe(0);
  });

  it("parseTimestamp reads ISO 8601 and rejects anything else", () => {
    expect(parseTimestamp("2030-01-02T10:00:00.000Z")).toBe(Date.UTC(2030, 0, 2, 10, 0, 0));
    expect(parseTimestamp("not a date")).toBeNull();
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp(1_900_000_000_000)).toBeNull();
  });
});
