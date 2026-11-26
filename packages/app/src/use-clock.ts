/** React bindings for the replay clock: a context, a selector hook and the frame driver. */

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import type { Clock, ClockState } from "./clock";

export const ClockContext = createContext<Clock | null>(null);

/** The clock of the nearest `ClockContext` provider. Throws outside one. */
export function useClock(): Clock {
  const clock = useContext(ClockContext);
  if (clock === null) throw new Error("useClock must be used inside a ClockContext provider");
  return clock;
}

/**
 * A value derived from the clock state. The component re-renders only when the selected value
 * changes (compared with `Object.is`), so select a primitive.
 */
export function useClockValue<T>(select: (state: ClockState) => T): T {
  const clock = useClock();
  const getSnapshot = useCallback(() => select(clock.getState()), [clock, select]);
  return useSyncExternalStore(clock.subscribe, getSnapshot, getSnapshot);
}

/** Frame scheduler, injectable for tests. */
export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

export const browserFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/** Advances the clock once per frame while it is playing. */
export function useClockDriver(clock: Clock, frames: FrameScheduler = browserFrames): void {
  const playing = useSyncExternalStore(
    clock.subscribe,
    () => clock.getState().playing,
    () => false,
  );
  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    let last = -1;
    const frame = (now: number): void => {
      if (last >= 0) clock.tick((now - last) / 1000);
      last = now;
      if (clock.getState().playing) handle = frames.request(frame);
    };
    handle = frames.request(frame);
    return () => frames.cancel(handle);
  }, [clock, frames, playing]);
}
