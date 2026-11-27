/**
 * The replay clock. The app owns replay time; the renderer only draws the time it is given.
 *
 * Time is in seconds on the compressed timeline (the same unit as every time in a replay). Use
 * `toRealSeconds` from @orbitrace/core to show it as real time.
 *
 * The clock is a tiny external store read with `useSyncExternalStore`, not React state, so a
 * frame tick re-renders only the few components that show the time (the playhead, the clock
 * readout), not the whole app sixty times a second.
 *
 * Follow live (issue 127). While the shown session runs, the clock is `live`: its timeline may still
 * grow. It is `following` when the playhead is pinned to the live edge (the end of the newest
 * snapshot):
 *
 * - A newer snapshot that extends the timeline starts a catch-up: the playhead moves across the
 *   newly revealed span in at most `FOLLOW_CATCH_UP_MAX_SECONDS` of wall time, and never slower
 *   than real time, so new calls, dispatches and handbacks are seen happening. Under reduced
 *   motion the app asks for a jump instead (`applySnapshot` with `animate: false`).
 * - Between snapshots the playhead holds at the edge and the clock still reports `playing`, so
 *   the renderer keeps its ambient motion (flowing spokes of calls still in flight, breathing
 *   halos) and the view does not look frozen. Calls that are still open end at the edge in the
 *   model, so they are drawn as in flight. Nothing is drawn past the edge: the model has no data
 *   there.
 * - Pausing and seeking (scrubbing, stepping, Home, choosing an earlier moment) leave follow, and
 *   leave the clock paused: holding at the edge is not playback the user started, so a scrub never
 *   starts the playhead moving (which reduced motion forbids anyway). `follow` (the Go live button)
 *   and `seekEnd` (the End key) return to follow and jump to the edge; Play plays on from there.
 *   Playing forward into the edge of a live timeline re-enters follow instead of stopping.
 * - `setLive(false)` (the session ended) ends follow: the view becomes an ordinary replay paused
 *   at its end. A playhead that was behind is not moved.
 */

/** Playback rates offered in the speed control. */
export const PLAYBACK_RATES = [1, 2, 4, 8, 16, 32, 64] as const;

/** Rate used when nothing else is asked for: a ten-minute session plays in about 75 seconds. */
export const DEFAULT_RATE = 8;

/** Longest step one frame may take, in seconds of wall time. A background tab does not jump. */
export const MAX_FRAME_STEP = 0.1;

/** Longest catch-up across a newly revealed span while following, in seconds of wall time. */
export const FOLLOW_CATCH_UP_MAX_SECONDS = 1;

/**
 * Wall seconds a catch-up across `span` compressed seconds takes: the span at real speed, but at
 * most `FOLLOW_CATCH_UP_MAX_SECONDS`. Compressed seconds after the newest cut are real seconds, so
 * half a second of activity plays in half a second, and a minute of it in one second.
 */
export function catchUpSeconds(span: number): number {
  if (!(span > 0)) return 0;
  return Math.min(FOLLOW_CATCH_UP_MAX_SECONDS, span);
}

/** A playhead moving from `from` to `to` over `length` wall seconds, `elapsed` of them done. */
export interface CatchUp {
  readonly from: number;
  readonly to: number;
  readonly length: number;
  readonly elapsed: number;
}

export interface ClockState {
  /** Current time on the compressed timeline, from 0 to `duration`. */
  readonly time: number;
  /** Advancing, or (while following) holding at the live edge. */
  readonly playing: boolean;
  /** Replay seconds per wall second. Greater than 0. */
  readonly rate: number;
  /** Length of the compressed timeline. */
  readonly duration: number;
  /** The shown session is running, so the timeline may still grow. */
  readonly live: boolean;
  /** Pinned to the live edge. Only while `live`; implies `playing`. */
  readonly following: boolean;
  /** A follow catch-up in progress, or `null`. */
  readonly catchUp: CatchUp | null;
}

export const INITIAL_CLOCK: ClockState = {
  time: 0,
  playing: false,
  rate: DEFAULT_RATE,
  duration: 0,
  live: false,
  following: false,
  catchUp: null,
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function lengthOf(duration: number): number {
  return Math.max(0, Number.isFinite(duration) ? duration : 0);
}

/**
 * The state after `wallSeconds` of playback. Pure. Does nothing while paused.
 *
 * - A catch-up moves the playhead linearly from `from` to `to` and ends there.
 * - Following with no catch-up holds at the edge.
 * - Otherwise time moves by `rate`. At the end of the timeline a live clock starts following; any
 *   other clock stops and pauses there.
 */
export function advance(state: ClockState, wallSeconds: number): ClockState {
  if (!state.playing) return state;
  const wall = clamp(wallSeconds, 0, MAX_FRAME_STEP);
  const catchUp = state.catchUp;
  if (catchUp !== null) {
    const elapsed = catchUp.elapsed + wall;
    // A microsecond of slack, so ten 0.1 s frames finish a 1 s catch-up despite rounding.
    if (elapsed >= catchUp.length - 1e-6) {
      const time = Math.min(state.duration, catchUp.to);
      // Following: hold at the edge. Ended during the catch-up: stop at the end.
      const playing = state.following || time < state.duration;
      return { ...state, time, playing, catchUp: null };
    }
    if (wall === 0) return state;
    const time = Math.min(
      state.duration,
      catchUp.from + (catchUp.to - catchUp.from) * (elapsed / catchUp.length),
    );
    return { ...state, time, catchUp: { ...catchUp, elapsed } };
  }
  if (state.following) {
    return state.time === state.duration ? state : { ...state, time: state.duration };
  }
  const time = Math.min(state.duration, state.time + wall * state.rate);
  if (time >= state.duration && state.live) {
    return { ...state, time: state.duration, following: true };
  }
  const playing = time < state.duration;
  if (time === state.time && playing === state.playing) return state;
  return { ...state, time, playing };
}

/** Whether the clock needs animation frames: playing, and not holding still at the live edge. */
export function needsFrames(state: ClockState): boolean {
  return state.playing && (state.catchUp !== null || !state.following);
}

/** A newer snapshot of the session shown: its length and where the playhead goes. */
export interface ClockSnapshot {
  /** Length of the new compressed timeline. */
  readonly duration: number;
  /**
   * The playhead on the new timeline, carried through real time by the caller (`remapTime`, or
   * `followStartTime` while following; see `follow.ts`). Default: the current time.
   */
  readonly time?: number;
  /** While following, move across the new span (`true`) or jump to the edge (`false`). */
  readonly animate: boolean;
}

export type ClockListener = () => void;

export interface Clock {
  getState(): ClockState;
  subscribe(listener: ClockListener): () => void;
  /** Start playback. At the end of the timeline: follow when live, otherwise start from 0. */
  play(): void;
  /** Stop playback. Leaves follow. */
  pause(): void;
  toggle(): void;
  /**
   * Jump to time `t`, clamped to the timeline. Leaves follow (and pauses), unless `t` is the edge.
   * Outside follow, playback carries on as it was.
   */
  seek(t: number): void;
  /** Move by `delta` seconds, clamped to the timeline. Leaves follow like `seek`. */
  seekBy(delta: number): void;
  /** The End key: follow when live, otherwise jump to the end. */
  seekEnd(): void;
  /** Go live: jump to the edge and follow it. Does nothing unless live. */
  follow(): void;
  /** The session started or stopped running. Stopping ends follow; see the file comment. */
  setLive(live: boolean): void;
  /** Set the playback rate. Values that are not finite and greater than 0 are ignored. */
  setRate(rate: number): void;
  /** A newer snapshot of the same session. See `ClockSnapshot`. */
  applySnapshot(snapshot: ClockSnapshot): void;
  /** Load a different replay: replace the whole state. `following` needs `live`. */
  reset(next: Partial<Omit<ClockState, "catchUp">> & { readonly duration: number }): void;
  /** Advance by `wallSeconds` of wall time (one frame). */
  tick(wallSeconds: number): void;
}

/** Create a clock. Fields left out of `initial` come from `INITIAL_CLOCK`. */
export function createClock(initial: Partial<ClockState> = {}): Clock {
  let state: ClockState = { ...INITIAL_CLOCK, ...initial };
  const listeners = new Set<ClockListener>();

  const set = (next: ClockState): void => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const follow = (): void => {
    if (!state.live) return;
    const pinned =
      state.following && state.playing && state.catchUp === null && state.time === state.duration;
    if (pinned) return;
    set({ ...state, time: state.duration, playing: true, following: true, catchUp: null });
  };
  const play = (): void => {
    if (state.playing) return;
    if (state.live && state.time >= state.duration) {
      follow();
      return;
    }
    if (state.duration <= 0) return;
    const time = state.time >= state.duration ? 0 : state.time;
    set({ ...state, time, playing: true });
  };
  const pause = (): void => {
    if (state.playing || state.following || state.catchUp !== null) {
      set({ ...state, playing: false, following: false, catchUp: null });
    }
  };
  const seek = (t: number): void => {
    const time = clamp(t, 0, state.duration);
    if (state.following && time >= state.duration) return;
    if (state.following || state.catchUp !== null) {
      // Leaving follow by a seek also stops playback: holding at the edge looks like playing, but
      // the user never started playback, so a scrub must not start it (at the default rate, and
      // under reduced motion too). Play, Go live and End resume.
      set({ ...state, time, playing: false, following: false, catchUp: null });
      return;
    }
    if (time === state.time) return;
    set({ ...state, time });
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
    seekEnd() {
      if (state.live) follow();
      else seek(state.duration);
    },
    follow,
    setLive(live) {
      if (live === state.live) return;
      if (live) {
        set({ ...state, live: true });
      } else if (state.following) {
        // A catch-up in progress finishes, then `advance` stops at the end.
        set({ ...state, live: false, following: false, playing: state.catchUp !== null });
      } else {
        set({ ...state, live: false });
      }
    },
    setRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0 || rate === state.rate) return;
      set({ ...state, rate });
    },
    applySnapshot(snapshot) {
      const duration = lengthOf(snapshot.duration);
      const time = clamp(snapshot.time ?? state.time, 0, duration);
      if (state.following) {
        const span = duration - time;
        const animated = snapshot.animate && span > 0;
        set({
          ...state,
          duration,
          time: animated ? time : duration,
          playing: true,
          catchUp: animated
            ? { from: time, to: duration, length: catchUpSeconds(span), elapsed: 0 }
            : null,
        });
        return;
      }
      // Playing into the edge of a live timeline keeps playing, and follows on the next frame.
      const playing = state.playing && (time < duration || state.live);
      const same =
        duration === state.duration &&
        time === state.time &&
        playing === state.playing &&
        state.catchUp === null;
      if (!same) set({ ...state, duration, time, playing, catchUp: null });
    },
    reset(next) {
      const duration = lengthOf(next.duration);
      const rate =
        next.rate !== undefined && Number.isFinite(next.rate) && next.rate > 0
          ? next.rate
          : state.rate;
      const live = next.live ?? false;
      const following = live && (next.following ?? false);
      const time = following ? duration : clamp(next.time ?? 0, 0, duration);
      const playing = following || ((next.playing ?? false) && time < duration);
      set({ time, playing, rate, duration, live, following, catchUp: null });
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
