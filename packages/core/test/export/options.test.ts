// Tickets #122 and #123: checking the opt-in export options. All data is invented.
import { describe, expect, it } from "vitest";
import {
  changesOutput,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_NAMES,
  exportReplay,
  isExportNames,
  isRoundTimesStep,
  resolveExportOptions,
  ROUND_TIMES_MAX_STEP,
  ROUND_TIMES_MIN_STEP,
  type ExportOptions,
} from "../../src/index.js";
import { makeModel, PLANTED } from "./model.js";

describe("isExportNames", () => {
  it("accepts the two values only", () => {
    expect(EXPORT_NAMES).toEqual(["as-written", "opaque"]);
    for (const value of EXPORT_NAMES) expect(isExportNames(value)).toBe(true);
    for (const value of ["Opaque", "hidden", "", null, undefined, 1, true]) {
      expect(isExportNames(value)).toBe(false);
    }
  });
});

describe("isRoundTimesStep", () => {
  it("accepts whole milliseconds from 0.001 to 3600", () => {
    expect(ROUND_TIMES_MIN_STEP).toBe(0.001);
    expect(ROUND_TIMES_MAX_STEP).toBe(3600);
    for (const value of [0.001, 0.01, 0.1, 0.25, 1, 5, 60, 3600, 0.1 + 0.2]) {
      expect(isRoundTimesStep(value)).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const value of [
      0,
      -1,
      0.0005,
      1 / 3,
      3600.001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0.1",
      null,
      undefined,
      true,
    ]) {
      expect(isRoundTimesStep(value)).toBe(false);
    }
  });
});

describe("resolveExportOptions", () => {
  it("gives the defaults when nothing is set", () => {
    expect(resolveExportOptions()).toEqual(DEFAULT_EXPORT_OPTIONS);
    expect(resolveExportOptions({})).toEqual(DEFAULT_EXPORT_OPTIONS);
    expect(resolveExportOptions({ pretty: true })).toEqual(DEFAULT_EXPORT_OPTIONS);
    expect(DEFAULT_EXPORT_OPTIONS).toEqual({
      names: "as-written",
      roundTimes: null,
      bucketTokens: false,
    });
  });

  it("keeps given values and snaps the step to whole milliseconds", () => {
    expect(resolveExportOptions({ names: "opaque", roundTimes: 0.1, bucketTokens: true })).toEqual({
      names: "opaque",
      roundTimes: 0.1,
      bucketTokens: true,
    });
    expect(resolveExportOptions({ roundTimes: 0.1 + 0.2 }).roundTimes).toBe(0.3);
  });

  it("throws a TypeError that names the option and never quotes the value", () => {
    const bad: ExportOptions[] = [
      { names: PLANTED as never },
      { names: null as never },
      { roundTimes: 0 },
      { roundTimes: PLANTED as never },
      { roundTimes: 1 / 3 },
      { bucketTokens: PLANTED as never },
      { bucketTokens: null as never },
    ];
    for (const options of bad) {
      let thrown: unknown;
      try {
        resolveExportOptions(options);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      const message = (thrown as Error).message;
      expect(message).toMatch(/^ExportOptions\.(names|roundTimes|bucketTokens) must be /);
      expect(message).not.toContain(PLANTED);
      expect(() => exportReplay(makeModel(), options)).toThrow(TypeError);
    }
  });
});

describe("changesOutput", () => {
  it("is false only for the defaults", () => {
    expect(changesOutput(DEFAULT_EXPORT_OPTIONS)).toBe(false);
    expect(changesOutput({ ...DEFAULT_EXPORT_OPTIONS, names: "opaque" })).toBe(true);
    expect(changesOutput({ ...DEFAULT_EXPORT_OPTIONS, roundTimes: 1 })).toBe(true);
    expect(changesOutput({ ...DEFAULT_EXPORT_OPTIONS, bucketTokens: true })).toBe(true);
  });
});
