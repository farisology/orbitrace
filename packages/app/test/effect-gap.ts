// A switch for finding tests that read the result of a React effect too early (issue 194).
//
// Outside `act`, React commits the DOM in one task and may run the passive effects of that
// commit in a later one. Testing Library's `findBy…` and `waitFor` resolve as soon as the DOM
// matches, so a test can continue between the two. On an idle machine the later task nearly
// always runs first and such a test passes; on a loaded one it fails now and then.
//
// With ORBITRACE_TEST_EFFECT_GAP_MS set to a number of milliseconds, every `setImmediate` waits
// that long first. React's scheduler runs its tasks with `setImmediate` in Node, so the gap
// between a commit and its effects becomes that wide and a test with this fault fails every
// time. From the repository root, after `npm run build`:
//
//   ORBITRACE_TEST_EFFECT_GAP_MS=30 npm test -w @orbitrace/app
//
// Unset (the default, and what CI runs) nothing is changed. `setup.ts` imports this file first,
// so the scheduler, which keeps the `setImmediate` it finds when it loads, picks up the slow one.

export const EFFECT_GAP_ENV = "ORBITRACE_TEST_EFFECT_GAP_MS";

/** The gap asked for, in milliseconds: 0 when the variable is unset, empty or not a number above 0. */
export function effectGapMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const gap = Number(value);
  return Number.isFinite(gap) && gap > 0 ? gap : 0;
}

/** The timer functions `installEffectGap` reads and replaces. `globalThis` fits. */
export interface ImmediateHost {
  setImmediate: typeof setImmediate;
  clearImmediate: typeof clearImmediate;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/**
 * Replace `host.setImmediate` with one that waits `gapMs` before it queues the callback, and
 * `host.clearImmediate` with one that also cancels during the wait. Returns a function that puts
 * the original two back.
 */
export function installEffectGap(host: ImmediateHost, gapMs: number): () => void {
  const real = {
    setImmediate: host.setImmediate,
    clearImmediate: host.clearImmediate,
    setTimeout: host.setTimeout,
    clearTimeout: host.clearTimeout,
  };
  type Waiting = { timer: ReturnType<typeof setTimeout>; immediate: NodeJS.Immediate | null };
  // What the slow `setImmediate` hands out, and how to cancel it in either phase.
  const waiting = new WeakMap<object, Waiting>();

  const slow = (callback: (...args: unknown[]) => void, ...args: unknown[]): object => {
    const handle = {};
    const entry: Waiting = {
      timer: real.setTimeout(() => {
        entry.immediate = real.setImmediate(callback, ...args);
      }, gapMs),
      immediate: null,
    };
    waiting.set(handle, entry);
    return handle;
  };

  const clear = (handle: unknown): void => {
    const entry = typeof handle === "object" && handle !== null ? waiting.get(handle) : undefined;
    if (entry === undefined) {
      real.clearImmediate(handle as NodeJS.Immediate | undefined);
      return;
    }
    real.clearTimeout(entry.timer);
    if (entry.immediate !== null) real.clearImmediate(entry.immediate);
  };

  host.setImmediate = slow as unknown as typeof setImmediate;
  host.clearImmediate = clear as typeof clearImmediate;
  return () => {
    host.setImmediate = real.setImmediate;
    host.clearImmediate = real.clearImmediate;
  };
}

const gap = effectGapMs(process.env[EFFECT_GAP_ENV]);
if (gap > 0) installEffectGap(globalThis, gap);
