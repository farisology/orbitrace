/**
 * The replay clock. The app owns replay time; the renderer only draws the time it is given.
 *
 * Time is in seconds on the compressed timeline (the same unit as every time in a replay). Use
 * `toRealSeconds` from @orbitrace/core to show it as real time.
 *
 * The clock is a tiny external store read with `useSyncExternalStore`, not React state, so a
 * frame tick re-renders only the few components that show the time (the playhead, the clock
 * readout), not the whole app sixty times a second.
 */

/** Playback rates offered in the speed control. */
export const PLAYBACK_RATES = [1, 2, 4, 8, 16, 32, 64] as const;

/** Rate used when nothing else is asked for: a ten-minute session plays in about 75 seconds. */
export const DEFAULT_RATE = 8;

/** Longest step one frame may take, in seconds of wall time. A background tab does not jump. */
export const MAX_FRAME_STEP = 0.1;

export interface ClockState {
  /** Current time on the compressed timeline, from 0 to `duration`. */
  readonly time: number;
  readonly playing: boolean;
  /** Replay seconds per wall second. Greater than 0. */
  readonly rate: number;
  /** Length of the compressed timeline. */
  readonly duration: number;
}

export const INITIAL_CLOCK: ClockState = {
  time: 0,
  playing: false,
  rate: DEFAULT_RATE,
  duration: 0,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * The state after `wallSeconds` of playback. Pure. Does nothing while paused. Stops at the end
 * of the timeline and pauses there.
 */
export function advance(state: ClockState, wallSeconds: number): ClockState {
  if (!state.playing) return state;
  const step = clamp(wallSeconds, 0, MAX_FRAME_STEP) * state.rate;
  const time = Math.min(state.duration, state.time + step);
  const playing = time < state.duration;
  if (time === state.time && playing === state.playing) return state;
  return { ...state, time, playing };
}

export type ClockListener = () => void;

export interface Clock {
  getState(): ClockState;
  subscribe(listener: ClockListener): () => void;
  /** Start playback. At the end of the timeline, starts again from 0. */
  play(): void;
  pause(): void;
  toggle(): void;
  /** Jump to time `t`, clamped to the timeline. */
  seek(t: number): void;
  /** Move by `delta` seconds, clamped to the timeline. */
  seekBy(delta: number): void;
  /** Set the playback rate. Values that are not finite and greater than 0 are ignored. */
  setRate(rate: number): void;
  /** A newer snapshot of the same session changed the length. Keeps the time, clamped. */
  setDuration(duration: number): void;
  /** Load a different replay: replace the whole state. */
  reset(next: Partial<ClockState> & { readonly duration: number }): void;
  /** Advance by `wallSeconds` of wall time (one frame). */
  tick(wallSeconds: number): void;
}

/** Create a clock. */
export function createClock(initial: ClockState = INITIAL_CLOCK): Clock {
  let state = initial;
  const listeners = new Set<ClockListener>();

  const set = (next: ClockState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const play = (): void => {
    if (state.playing || state.duration <= 0) return;
    const time = state.time >= state.duration ? 0 : state.time;
    set({ ...state, time, playing: true });
  };
  const pause = (): void => {
    if (state.playing) set({ ...state, playing: false });
  };
  const seek = (t: number): void => {
    const time = clamp(t, 0, state.duration);
    if (time !== state.time) set({ ...state, time });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    play,
    pause,
    toggle() {
      if (state.playing) pause();
      else play();
    },
    seek,
    seekBy(delta) {
      seek(state.time + delta);
    },
    setRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0 || rate === state.rate) return;
      set({ ...state, rate });
    },
    setDuration(duration) {
      const length = Math.max(0, Number.isFinite(duration) ? duration : 0);
      if (length === state.duration) return;
      const time = Math.min(state.time, length);
      set({ ...state, duration: length, time, playing: state.playing && time < length });
    },
    reset(next) {
      const duration = Math.max(0, Number.isFinite(next.duration) ? next.duration : 0);
      const rate =
        next.rate !== undefined && Number.isFinite(next.rate) && next.rate > 0
          ? next.rate
          : state.rate;
      const time = clamp(next.time ?? 0, 0, duration);
      const playing = (next.playing ?? false) && time < duration;
      set({ time, playing, rate, duration });
    },
    tick(wallSeconds) {
      set(advance(state, wallSeconds));
    },
  };
}

/** Number of items whose `t` is at or before `time`, for items sorted by `t`. Binary search. */
export function countAtOrBefore(items: readonly { readonly t: number }[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((items[mid] as { t: number }).t <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}
