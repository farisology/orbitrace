import { describe, expect, it } from "vitest";
import { NO_START_OPTIONS, parseStartOptions, startSelection } from "../src/url-state";
import { makeModel } from "./helpers";

describe("start options", () => {
  it("reads time, selection, speed and paused", () => {
    expect(parseStartOptions("?t=200&select=a5&speed=16&paused")).toEqual({
      time: 200,
      select: "a5",
      rate: 16,
      paused: true,
    });
  });

  it("ignores malformed values", () => {
    expect(parseStartOptions("?t=-3&select=a0&speed=3")).toEqual(NO_START_OPTIONS);
    expect(parseStartOptions("?t=&select=../x&speed=abc&paused=false")).toEqual(NO_START_OPTIONS);
    expect(parseStartOptions("")).toEqual(NO_START_OPTIONS);
  });

  it("selects only an agent the model has", () => {
    const model = makeModel();
    expect(startSelection({ ...NO_START_OPTIONS, select: "a2" }, model)).toBe("a2");
    expect(startSelection({ ...NO_START_OPTIONS, select: "a7" }, model)).toBeNull();
    expect(startSelection(NO_START_OPTIONS, model)).toBeNull();
  });
});
