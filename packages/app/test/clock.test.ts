import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RATE,
  INITIAL_CLOCK,
  MAX_FRAME_STEP,
  advance,
  countAtOrBefore,
  createClock,
} from "../src/clock";

describe("advance", () => {
  const playing = { time: 10, playing: true, rate: 4, duration: 100 };

  it("moves time by wall seconds times the rate", () => {
    expect(advance(playing, 0.05)).toEqual({ ...playing, time: 10.2 });
  });

  it("caps one step so a background tab does not jump", () => {
    expect(advance(playing, 5).time).toBeCloseTo(10 + MAX_FRAME_STEP * 4);
  });

  it("stops and pauses at the end", () => {
    const next = advance({ ...playing, time: 99.9 }, 0.1);
    expect(next.time).toBe(100);
    expect(next.playing).toBe(false);
  });

  it("does nothing while paused or for a bad step", () => {
    const paused = { ...playing, playing: false };
    expect(advance(paused, 0.1)).toBe(paused);
    expect(advance(playing, Number.NaN)).toBe(playing);
    expect(advance(playing, -1)).toBe(playing);
  });
});

describe("createClock", () => {
  it("starts paused at 0 with the default rate", () => {
    expect(createClock().getState()).toEqual(INITIAL_CLOCK);
    expect(INITIAL_CLOCK.rate).toBe(DEFAULT_RATE);
  });

  it("plays, pauses and toggles, and tells subscribers", () => {
    const clock = createClock({ ...INITIAL_CLOCK, duration: 50 });
    const listener = vi.fn();
    const off = clock.subscribe(listener);
    clock.play();
    expect(clock.getState().playing).toBe(true);
    clock.toggle();
    expect(clock.getState().playing).toBe(false);
    clock.toggle();
    expect(clock.getState().playing).toBe(true);
    clock.pause();
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    clock.play();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("restarts from 0 when played at the end, and will not play an empty timeline", () => {
    const clock = createClock({ ...INITIAL_CLOCK, time: 50, duration: 50 });
    clock.play();
    expect(clock.getState()).toMatchObject({ time: 0, playing: true });
    const empty = createClock();
    empty.play();
    expect(empty.getState().playing).toBe(false);
  });

  it("seeks within the timeline", () => {
    const clock = createClock({ ...INITIAL_CLOCK, duration: 50 });
    clock.seek(20);
    expect(clock.getState().time).toBe(20);
    clock.seekBy(-30);
    expect(clock.getState().time).toBe(0);
    clock.seekBy(80);
    expect(clock.getState().time).toBe(50);
    clock.seek(Number.NaN);
    expect(clock.getState().time).toBe(0);
  });

  it("accepts only positive finite rates", () => {
    const clock = createClock();
    clock.setRate(16);
    expect(clock.getState().rate).toBe(16);
    clock.setRate(0);
    clock.setRate(-2);
    clock.setRate(Number.POSITIVE_INFINITY);
    expect(clock.getState().rate).toBe(16);
  });

  it("keeps the time when the duration grows and clamps it when it shrinks", () => {
    const clock = createClock({ time: 40, playing: true, rate: 1, duration: 50 });
    clock.setDuration(80);
    expect(clock.getState()).toMatchObject({ time: 40, duration: 80, playing: true });
    clock.setDuration(30);
    expect(clock.getState()).toMatchObject({ time: 30, duration: 30, playing: false });
    clock.setDuration(Number.NaN);
    expect(clock.getState().duration).toBe(0);
  });

  it("resets for a new replay, keeping the rate unless given", () => {
    const clock = createClock({ time: 40, playing: true, rate: 2, duration: 50 });
    clock.reset({ duration: 100, time: 150, playing: true });
    expect(clock.getState()).toEqual({ time: 100, playing: false, rate: 2, duration: 100 });
    clock.reset({ duration: 100, time: 10, playing: true, rate: 32 });
    expect(clock.getState()).toEqual({ time: 10, playing: true, rate: 32, duration: 100 });
    clock.reset({ duration: 100, rate: -1 });
    expect(clock.getState()).toEqual({ time: 0, playing: false, rate: 32, duration: 100 });
  });

  it("ticks forward while playing", () => {
    const clock = createClock({ time: 0, playing: true, rate: 10, duration: 100 });
    clock.tick(0.05);
    expect(clock.getState().time).toBeCloseTo(0.5);
  });
});

describe("countAtOrBefore", () => {
  const items = [{ t: 1 }, { t: 2 }, { t: 2 }, { t: 5 }];

  it("counts items at or before a time", () => {
    expect(countAtOrBefore(items, 0)).toBe(0);
    expect(countAtOrBefore(items, 1)).toBe(1);
    expect(countAtOrBefore(items, 2)).toBe(3);
    expect(countAtOrBefore(items, 4.9)).toBe(3);
    expect(countAtOrBefore(items, 99)).toBe(4);
    expect(countAtOrBefore([], 3)).toBe(0);
  });
});
