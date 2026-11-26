import { describe, expect, it } from "vitest";
import { SCRUB_STEP, SCRUB_STEP_LARGE, keyAction, targetHandlesKey } from "../src/keyboard";

const key = (k: string, extra: Partial<Parameters<typeof keyAction>[0]> = {}) => ({
  key: k,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...extra,
});

describe("keyAction", () => {
  it("maps space and K to play or pause", () => {
    expect(keyAction(key(" "))).toEqual({ type: "toggle" });
    expect(keyAction(key("k"))).toEqual({ type: "toggle" });
    expect(keyAction(key("Spacebar"))).toEqual({ type: "toggle" });
  });

  it("maps arrows to scrubbing, larger with Shift", () => {
    expect(keyAction(key("ArrowLeft"))).toEqual({ type: "seekBy", delta: -SCRUB_STEP });
    expect(keyAction(key("ArrowRight"))).toEqual({ type: "seekBy", delta: SCRUB_STEP });
    expect(keyAction(key("ArrowLeft", { shiftKey: true }))).toEqual({
      type: "seekBy",
      delta: -SCRUB_STEP_LARGE,
    });
    expect(keyAction(key("ArrowRight", { shiftKey: true }))).toEqual({
      type: "seekBy",
      delta: SCRUB_STEP_LARGE,
    });
  });

  it("maps Home, End and Escape", () => {
    expect(keyAction(key("Home"))).toEqual({ type: "seekTo", to: "start" });
    expect(keyAction(key("End"))).toEqual({ type: "seekTo", to: "end" });
    expect(keyAction(key("Escape"))).toEqual({ type: "clearSelection" });
  });

  it("ignores other keys and modified keys", () => {
    expect(keyAction(key("a"))).toBeNull();
    expect(keyAction(key(" ", { ctrlKey: true }))).toBeNull();
    expect(keyAction(key("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(keyAction(key("ArrowLeft", { altKey: true }))).toBeNull();
  });
});

describe("targetHandlesKey", () => {
  const make = (tag: string, type?: string) => {
    const element = document.createElement(tag);
    if (type !== undefined) (element as HTMLInputElement).type = type;
    return element;
  };

  it("leaves typing and sliders to the control", () => {
    expect(targetHandlesKey(make("input", "text"), " ")).toBe(true);
    expect(targetHandlesKey(make("input", "range"), "ArrowLeft")).toBe(true);
    expect(targetHandlesKey(make("textarea"), "k")).toBe(true);
    expect(targetHandlesKey(make("select"), "ArrowRight")).toBe(true);
  });

  it("leaves a slider its movement keys but not space or K", () => {
    const range = make("input", "range");
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
      expect(targetHandlesKey(range, key)).toBe(true);
    }
    expect(targetHandlesKey(range, " ")).toBe(false);
    expect(targetHandlesKey(range, "k")).toBe(false);
    expect(targetHandlesKey(range, "Escape")).toBe(false);
  });

  it("leaves space on buttons and check boxes to them, but not arrows", () => {
    expect(targetHandlesKey(make("button"), " ")).toBe(true);
    expect(targetHandlesKey(make("button"), "ArrowLeft")).toBe(false);
    expect(targetHandlesKey(make("input", "checkbox"), " ")).toBe(true);
    expect(targetHandlesKey(make("input", "checkbox"), "ArrowLeft")).toBe(false);
  });

  it("handles nothing for the page or a plain element", () => {
    expect(targetHandlesKey(null, " ")).toBe(false);
    expect(targetHandlesKey(document.body, " ")).toBe(false);
    expect(targetHandlesKey(make("div"), "ArrowLeft")).toBe(false);
    expect(targetHandlesKey(window, " ")).toBe(false);
  });
});
