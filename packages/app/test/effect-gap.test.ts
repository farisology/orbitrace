import { describe, expect, it } from "vitest";
import { EFFECT_GAP_ENV, effectGapMs, installEffectGap, type ImmediateHost } from "./effect-gap";

/**
 * A host whose timers the test fires by hand, so nothing here depends on the clock. Handles are
 * plain objects; `timers` and `immediates` hold what is waiting, `cleared` what was cancelled.
 */
function manualHost() {
  const timers: { handle: object; ms: number; fire: () => void }[] = [];
  const immediates: { handle: object; run: () => void }[] = [];
  const cleared: unknown[] = [];
  const original = {
    setImmediate: ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      const handle = { kind: "immediate" };
      immediates.push({ handle, run: () => callback(...args) });
      return handle;
    }) as unknown as typeof setImmediate,
    clearImmediate: ((handle: unknown) => {
      cleared.push(handle);
    }) as typeof clearImmediate,
    setTimeout: ((callback: () => void, ms: number) => {
      const handle = { kind: "timer" };
      timers.push({ handle, ms, fire: callback });
      return handle;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((handle: unknown) => {
      cleared.push(handle);
    }) as typeof clearTimeout,
  };
  const host: ImmediateHost = { ...original };
  return { host, original, timers, immediates, cleared };
}

describe("effectGapMs", () => {
  it("is off unless the variable holds a number above 0", () => {
    expect(EFFECT_GAP_ENV).toBe("ORBITRACE_TEST_EFFECT_GAP_MS");
    for (const value of [undefined, "", "  ", "0", "-5", "abc", "Infinity", "NaN"]) {
      expect(effectGapMs(value)).toBe(0);
    }
    expect(effectGapMs("30")).toBe(30);
    expect(effectGapMs(" 2.5 ")).toBe(2.5);
  });
});

describe("installEffectGap", () => {
  it("queues an immediate only after the gap, and passes its arguments on", () => {
    const { host, timers, immediates } = manualHost();
    installEffectGap(host, 40);
    const seen: unknown[][] = [];
    host.setImmediate((...args: unknown[]) => seen.push(args), "first", 2);
    // Waiting out the gap on a timer; nothing is queued yet.
    expect(timers.map((timer) => timer.ms)).toEqual([40]);
    expect(immediates).toEqual([]);
    timers[0]?.fire();
    expect(immediates).toHaveLength(1);
    expect(seen).toEqual([]);
    immediates[0]?.run();
    expect(seen).toEqual([["first", 2]]);
  });

  it("cancels an immediate during the gap, so it is never queued", () => {
    const { host, timers, immediates, cleared } = manualHost();
    installEffectGap(host, 20);
    const handle = host.setImmediate(() => {});
    host.clearImmediate(handle);
    expect(cleared).toEqual([timers[0]?.handle]);
    expect(immediates).toEqual([]);
  });

  it("cancels an immediate that the gap has already queued", () => {
    const { host, timers, immediates, cleared } = manualHost();
    installEffectGap(host, 20);
    const handle = host.setImmediate(() => {});
    timers[0]?.fire();
    host.clearImmediate(handle);
    expect(cleared).toEqual([timers[0]?.handle, immediates[0]?.handle]);
  });

  it("hands any other handle to the original clearImmediate", () => {
    const { host, cleared } = manualHost();
    installEffectGap(host, 20);
    const other = { kind: "immediate" };
    host.clearImmediate(other as unknown as NodeJS.Immediate);
    host.clearImmediate(undefined);
    expect(cleared).toEqual([other, undefined]);
  });

  it("puts the original functions back", () => {
    const { host, original } = manualHost();
    const restore = installEffectGap(host, 10);
    expect(host.setImmediate).not.toBe(original.setImmediate);
    expect(host.clearImmediate).not.toBe(original.clearImmediate);
    restore();
    expect(host.setImmediate).toBe(original.setImmediate);
    expect(host.clearImmediate).toBe(original.clearImmediate);
  });

  it("with the real timers, lets a timer shorter than the gap run before the immediate", async () => {
    const host: ImmediateHost = { setImmediate, clearImmediate, setTimeout, clearTimeout };
    const restore = installEffectGap(host, 40);
    const order: string[] = [];
    // Without the gap an immediate runs before any timer. Timers fire in the order they are due,
    // however late the machine is, so the 5 ms one is always first here.
    const ran = new Promise<void>((resolve) => {
      host.setImmediate(() => {
        order.push("immediate");
        resolve();
      });
    });
    setTimeout(() => order.push("timer"), 5);
    await ran;
    expect(order).toEqual(["timer", "immediate"]);
    restore();
  });

  it("is installed on the global timers exactly when the variable asks for a gap", () => {
    // Unset in a normal run and in CI: the global `setImmediate` is Node's own.
    const asked = effectGapMs(process.env[EFFECT_GAP_ENV]) > 0;
    expect(globalThis.setImmediate.name !== "setImmediate").toBe(asked);
  });
});
