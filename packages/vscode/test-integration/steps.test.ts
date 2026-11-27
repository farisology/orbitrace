import { describe, expect, it } from "vitest";
import {
  delay,
  errorMessage,
  runSteps,
  summarizeReport,
  waitFor,
  withTimeout,
  type Step,
} from "./steps.js";

describe("errorMessage", () => {
  it("uses an error's message, its name when the message is empty, or the value as text", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TypeError(""))).toBe("TypeError");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("withTimeout", () => {
  it("resolves with the promise's value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "x")).resolves.toBe(7);
  });

  it("passes a rejection through", async () => {
    await expect(withTimeout(Promise.reject(new Error("no")), 1_000, "x")).rejects.toThrow("no");
  });

  it("rejects with the label when the promise is too slow", async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, "slow step")).rejects.toThrow(
      "slow step timed out after 10 ms",
    );
  });
});

describe("delay", () => {
  it("resolves after roughly the given time", async () => {
    const started = Date.now();
    await delay(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("waitFor", () => {
  it("resolves with the first value that is not undefined", async () => {
    let calls = 0;
    const value = await waitFor(() => (++calls >= 3 ? `call ${calls}` : undefined), {
      label: "x",
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(value).toBe("call 3");
  });

  it("accepts a probe that returns a promise, and falsy values other than undefined", async () => {
    await expect(waitFor(() => Promise.resolve(0), { label: "x", timeoutMs: 100 })).resolves.toBe(
      0,
    );
  });

  it("rejects with the label after the timeout", async () => {
    await expect(
      waitFor(() => undefined, { label: "the thing", timeoutMs: 20, intervalMs: 5 }),
    ).rejects.toThrow("timed out waiting for the thing (20 ms)");
  });

  it("rejects at once when the probe throws", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("probe failed");
        },
        { label: "x", timeoutMs: 10_000 },
      ),
    ).rejects.toThrow("probe failed");
  });
});

describe("runSteps", () => {
  it("runs every step in order and reports each one", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    let clock = 0;
    const steps: Step[] = [
      { name: "one", run: () => void order.push("one") },
      {
        name: "two",
        run: async () => {
          order.push("two");
          clock += 5;
        },
      },
    ];
    const report = await runSteps(steps, {
      timeoutMs: 1_000,
      log: (l) => lines.push(l),
      now: () => clock,
    });
    expect(order).toEqual(["one", "two"]);
    expect(report).toMatchObject({ passed: 2, failed: 0, skipped: 0 });
    expect(report.results.map((r) => r.durationMs)).toEqual([0, 5]);
    expect(lines).toEqual(["  ok        one (0 ms)", "  ok        two (5 ms)"]);
  });

  it("stops at the first failure and skips the rest", async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const report = await runSteps(
      [
        { name: "a", run: () => void ran.push("a") },
        {
          name: "b",
          run: () => {
            throw new Error("b broke");
          },
        },
        { name: "c", run: () => void ran.push("c") },
      ],
      { timeoutMs: 1_000, log: (l) => lines.push(l) },
    );
    expect(ran).toEqual(["a"]);
    expect(report).toMatchObject({ passed: 1, failed: 1, skipped: 1 });
    expect(report.results[1]).toMatchObject({ name: "b", outcome: "failed", error: "b broke" });
    expect(report.results[2]).toEqual({ name: "c", outcome: "skipped", durationMs: 0 });
    expect(lines.some((l) => l.includes("FAILED    b"))).toBe(true);
    expect(lines).toContain("  - skipped  c");
  });

  it("fails a step that runs longer than its own timeout", async () => {
    const report = await runSteps(
      [{ name: "hangs", timeoutMs: 10, run: () => new Promise<void>(() => undefined) }],
      { timeoutMs: 10_000 },
    );
    expect(report.results[0]?.error).toBe("hangs timed out after 10 ms");
  });

  it("works without a log", async () => {
    const report = await runSteps([], { timeoutMs: 10 });
    expect(report).toEqual({ results: [], passed: 0, failed: 0, skipped: 0 });
  });
});

describe("summarizeReport", () => {
  it("sums a report up in one line", () => {
    expect(summarizeReport({ results: [], passed: 9, failed: 1, skipped: 2 })).toBe(
      "9 passed, 1 failed, 2 skipped",
    );
  });
});
