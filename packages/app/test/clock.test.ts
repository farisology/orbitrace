import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RATE,
  FOLLOW_CATCH_UP_MAX_SECONDS,
  INITIAL_CLOCK,
  MAX_FRAME_STEP,
  advance,
  catchUpSeconds,
  countAtOrBefore,
  createClock,
  needsFrames,
  type ClockState,
} from "../src/clock";

describe("advance", () => {
  const playing: ClockState = { ...INITIAL_CLOCK, time: 10, playing: true, rate: 4, duration: 100 };

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

  it("keeps the time when a snapshot grows the timeline and clamps it when it shrinks", () => {
    const clock = createClock({ time: 40, playing: true, rate: 1, duration: 50 });
    const listener = vi.fn();
    clock.subscribe(listener);
    clock.applySnapshot({ duration: 80, animate: true });
    expect(clock.getState()).toMatchObject({ time: 40, duration: 80, playing: true });
    clock.applySnapshot({ duration: 80, animate: true });
    expect(listener).toHaveBeenCalledTimes(1);
    clock.applySnapshot({ duration: 30, animate: true });
    expect(clock.getState()).toMatchObject({ time: 30, duration: 30, playing: false });
    clock.applySnapshot({ duration: Number.NaN, animate: true });
    expect(clock.getState().duration).toBe(0);
  });

  it("puts the playhead where the snapshot says, for a time carried through real time", () => {
    const clock = createClock({ time: 40, playing: false, duration: 50 });
    clock.applySnapshot({ duration: 70, time: 36, animate: true });
    expect(clock.getState()).toMatchObject({ time: 36, duration: 70, playing: false });
  });

  it("resets for a new replay, keeping the rate unless given", () => {
    const clock = createClock({ time: 40, playing: true, rate: 2, duration: 50 });
    clock.reset({ duration: 100, time: 150, playing: true });
    expect(clock.getState()).toEqual({
      ...INITIAL_CLOCK,
      time: 100,
      playing: false,
      rate: 2,
      duration: 100,
    });
    clock.reset({ duration: 100, time: 10, playing: true, rate: 32 });
    expect(clock.getState()).toEqual({
      ...INITIAL_CLOCK,
      time: 10,
      playing: true,
      rate: 32,
      duration: 100,
    });
    clock.reset({ duration: 100, rate: -1 });
    expect(clock.getState()).toEqual({ ...INITIAL_CLOCK, rate: 32, duration: 100 });
  });

  it("resets into follow at the live edge, and only when live", () => {
    const clock = createClock();
    clock.reset({ duration: 90, time: 5, playing: false, live: true, following: true });
    expect(clock.getState()).toMatchObject({
      time: 90,
      playing: true,
      live: true,
      following: true,
      catchUp: null,
    });
    clock.reset({ duration: 90, time: 5, following: true });
    expect(clock.getState()).toMatchObject({ time: 5, live: false, following: false });
  });

  it("ticks forward while playing", () => {
    const clock = createClock({ time: 0, playing: true, rate: 10, duration: 100 });
    clock.tick(0.05);
    expect(clock.getState().time).toBeCloseTo(0.5);
  });
});

describe("follow live (#127)", () => {
  /** A clock following a live timeline of `duration` seconds. */
  function following(duration = 40) {
    const clock = createClock();
    clock.reset({ duration, live: true, following: true });
    return clock;
  }

  it("catch-up takes the span at real speed, at most one second", () => {
    expect(catchUpSeconds(0.25)).toBe(0.25);
    expect(catchUpSeconds(30)).toBe(FOLLOW_CATCH_UP_MAX_SECONDS);
    expect(catchUpSeconds(0)).toBe(0);
    expect(catchUpSeconds(Number.NaN)).toBe(0);
  });

  it("animates across a newly revealed span and holds at the new edge", () => {
    const clock = following(40);
    clock.applySnapshot({ duration: 60, time: 40, animate: true });
    expect(clock.getState()).toMatchObject({
      time: 40,
      duration: 60,
      following: true,
      playing: true,
      catchUp: { from: 40, to: 60, length: 1, elapsed: 0 },
    });
    const times: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      clock.tick(0.1);
      times.push(clock.getState().time);
    }
    expect(times[0]).toBeCloseTo(42);
    expect(times[4]).toBeCloseTo(50);
    expect(times[9]).toBe(60);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1] as number);
    }
    expect(clock.getState()).toMatchObject({ catchUp: null, following: true, playing: true });
    // Holding at the edge: more frames change nothing.
    const held = clock.getState();
    clock.tick(0.1);
    expect(clock.getState()).toBe(held);
  });

  it("jumps to the new edge when not animated (reduced motion)", () => {
    const clock = following(40);
    clock.applySnapshot({ duration: 60, time: 40, animate: false });
    expect(clock.getState()).toMatchObject({ time: 60, catchUp: null, following: true });
  });

  it("restarts a catch-up from where the playhead is when another snapshot arrives", () => {
    const clock = following(40);
    clock.applySnapshot({ duration: 60, time: 40, animate: true });
    clock.tick(0.1);
    clock.tick(0.1);
    const at = clock.getState().time;
    clock.applySnapshot({ duration: 61, time: at, animate: true });
    expect(clock.getState().catchUp).toEqual({ from: at, to: 61, length: 1, elapsed: 0 });
    expect(clock.getState().time).toBe(at);
  });

  it("needs frames while playing or catching up, not while holding at the edge", () => {
    expect(needsFrames(INITIAL_CLOCK)).toBe(false);
    expect(needsFrames({ ...INITIAL_CLOCK, playing: true })).toBe(true);
    const clock = following(40);
    expect(needsFrames(clock.getState())).toBe(false);
    clock.applySnapshot({ duration: 45, time: 40, animate: true });
    expect(needsFrames(clock.getState())).toBe(true);
  });

  it("pausing, seeking and stepping leave follow, paused; seeking to the edge does not", () => {
    const clock = following(40);
    clock.seek(40);
    expect(clock.getState().following).toBe(true);
    clock.seekBy(5);
    expect(clock.getState().following).toBe(true);
    clock.seekBy(-5);
    // Leaving follow by a seek pauses: nothing moves until the user plays or goes live.
    expect(clock.getState()).toMatchObject({ time: 35, following: false, playing: false });
    expect(needsFrames(clock.getState())).toBe(false);
    clock.tick(0.1);
    expect(clock.getState().time).toBe(35);
    clock.follow();
    clock.pause();
    expect(clock.getState()).toMatchObject({ time: 40, following: false, playing: false });
    clock.follow();
    clock.applySnapshot({ duration: 50, time: 40, animate: true });
    clock.seek(20);
    expect(clock.getState()).toMatchObject({
      time: 20,
      following: false,
      playing: false,
      catchUp: null,
    });
  });

  it("a seek outside follow keeps playback as it was", () => {
    const clock = following(40);
    clock.seek(10);
    clock.play();
    clock.seek(20);
    expect(clock.getState()).toMatchObject({ time: 20, following: false, playing: true });
    clock.pause();
    clock.seek(5);
    expect(clock.getState()).toMatchObject({ time: 5, playing: false });
  });

  it("Go live and End jump to the edge and follow; End only seeks when not live", () => {
    const clock = following(40);
    clock.seek(10);
    clock.pause();
    clock.follow();
    expect(clock.getState()).toMatchObject({ time: 40, following: true, playing: true });
    clock.seek(10);
    clock.seekEnd();
    expect(clock.getState()).toMatchObject({ time: 40, following: true });
    const replay = createClock({ duration: 40, time: 10 });
    replay.follow();
    expect(replay.getState()).toMatchObject({ time: 10, following: false, playing: false });
    replay.seekEnd();
    expect(replay.getState()).toMatchObject({ time: 40, following: false, playing: false });
  });

  it("playing into the edge of a live timeline re-enters follow; Play at the edge follows", () => {
    const clock = following(40);
    clock.seek(39);
    clock.play();
    clock.tick(0.1);
    clock.tick(0.1);
    expect(clock.getState()).toMatchObject({ time: 40, following: true, playing: true });
    clock.pause();
    clock.play();
    expect(clock.getState()).toMatchObject({ time: 40, following: true, playing: true });
  });

  it("a snapshot keeps a user who plays into the edge playing", () => {
    const clock = following(40);
    clock.seek(30);
    clock.play();
    clock.applySnapshot({ duration: 30, time: 30, animate: true });
    expect(clock.getState()).toMatchObject({ time: 30, playing: true, following: false });
    clock.tick(0.1);
    expect(clock.getState().following).toBe(true);
  });

  it("the session ending ends follow at the end; a user behind is not moved", () => {
    const clock = following(40);
    clock.setLive(false);
    expect(clock.getState()).toMatchObject({
      time: 40,
      live: false,
      following: false,
      playing: false,
    });
    const behind = following(40);
    behind.seek(12);
    behind.pause();
    behind.setLive(false);
    expect(behind.getState()).toMatchObject({ time: 12, live: false, playing: false });
    behind.setLive(true);
    expect(behind.getState()).toMatchObject({ live: true, following: false, time: 12 });
  });

  it("a catch-up running when the session ends finishes and stops at the end", () => {
    const clock = following(40);
    clock.applySnapshot({ duration: 41, time: 40, animate: true });
    clock.setLive(false);
    expect(clock.getState()).toMatchObject({ following: false, playing: true });
    for (let i = 0; i < 12; i += 1) clock.tick(0.1);
    expect(clock.getState()).toMatchObject({ time: 41, playing: false, catchUp: null });
  });

  it("follow does nothing when the clock is not live, and nothing when already pinned", () => {
    const listener = vi.fn();
    const clock = following(40);
    clock.subscribe(listener);
    clock.follow();
    clock.setLive(true);
    expect(listener).not.toHaveBeenCalled();
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
