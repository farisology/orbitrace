/**
 * A small sequential step runner for the integration suite. The suite drives one editor
 * window through one story (activate, list, open, talk, close, demo), so each step depends on
 * the state the steps before it left. The first failing step stops the run and the rest are
 * reported as skipped, instead of failing again for the same cause.
 *
 * No vscode dependency, so it is unit tested (`steps.test.ts`).
 */

/** One step of the story. */
export interface Step {
  readonly name: string;
  run(): Promise<void> | void;
  /** Milliseconds before the step fails. Default: `RunStepsOptions.timeoutMs`. */
  readonly timeoutMs?: number;
  /**
   * Checked just before the step would run: a reason (one line) skips the step and is logged
   * with it, `undefined` runs it. For a step that cannot run here, such as one that needs
   * `node:sqlite` in an editor whose Node lacks it. A skipped step does not stop the run.
   */
  skip?(): string | undefined;
}

export type StepOutcome = "passed" | "failed" | "skipped";

export interface StepResult {
  readonly name: string;
  readonly outcome: StepOutcome;
  /** Milliseconds the step ran. 0 for a skipped step. */
  readonly durationMs: number;
  /** The failure message, for a failed step. */
  readonly error?: string;
  /** Why the step was skipped, when its `skip` gave a reason. */
  readonly skipReason?: string;
}

export interface StepReport {
  readonly results: readonly StepResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface RunStepsOptions {
  /** Default timeout of a step, in milliseconds. */
  readonly timeoutMs: number;
  /** Receives one line per step. Default: no output. */
  readonly log?: (line: string) => void;
  /** Clock, for tests. Default `Date.now`. */
  readonly now?: () => number;
}

/** The message of a thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return String(error);
}

/**
 * `promise`, or a rejection with `<label> timed out after <ms> ms` when it does not settle in
 * time. The timer is cleared either way, so it never keeps a process alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WaitForOptions {
  /** What is awaited, for the timeout message. */
  readonly label: string;
  readonly timeoutMs: number;
  /** Milliseconds between checks. Default 50. */
  readonly intervalMs?: number;
}

/**
 * Check `probe` until it returns a value other than `undefined` (or a promise of one), and
 * resolve with that value. Rejects with `timed out waiting for <label>` after `timeoutMs`. An
 * exception thrown by `probe` rejects at once.
 */
export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  options: WaitForOptions,
): Promise<T> {
  const interval = options.intervalMs ?? 50;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${options.label} (${options.timeoutMs} ms)`);
    }
    await delay(interval);
  }
}

/** Run the steps in order; stop at the first failure and skip the rest. Never rejects. */
export async function runSteps(
  steps: readonly Step[],
  options: RunStepsOptions,
): Promise<StepReport> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const results: StepResult[] = [];
  let stopped = false;
  for (const step of steps) {
    if (stopped) {
      results.push({ name: step.name, outcome: "skipped", durationMs: 0 });
      log(`  - skipped  ${step.name}`);
      continue;
    }
    const started = now();
    try {
      const reason = step.skip?.();
      if (reason !== undefined) {
        results.push({ name: step.name, outcome: "skipped", durationMs: 0, skipReason: reason });
        log(`  - skipped  ${step.name} (${reason})`);
        continue;
      }
      const timeoutMs = step.timeoutMs ?? options.timeoutMs;
      await withTimeout(
        Promise.resolve().then(() => step.run()),
        timeoutMs,
        step.name,
      );
      const durationMs = now() - started;
      results.push({ name: step.name, outcome: "passed", durationMs });
      log(`  ok        ${step.name} (${durationMs} ms)`);
    } catch (error) {
      const durationMs = now() - started;
      const message = errorMessage(error);
      results.push({ name: step.name, outcome: "failed", durationMs, error: message });
      log(`  FAILED    ${step.name} (${durationMs} ms)`);
      log(`            ${message}`);
      stopped = true;
    }
  }
  const count = (outcome: StepOutcome): number =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    results,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
}

/** One report for several runs of `runSteps`, in order: their results and counts together. */
export function mergeReports(reports: readonly StepReport[]): StepReport {
  const results = reports.flatMap((report) => report.results);
  const sum = (pick: (report: StepReport) => number): number =>
    reports.reduce((total, report) => total + pick(report), 0);
  return {
    results,
    passed: sum((report) => report.passed),
    failed: sum((report) => report.failed),
    skipped: sum((report) => report.skipped),
  };
}

/** One line that sums up a report, for example `9 passed, 1 failed, 2 skipped`. */
export function summarizeReport(report: StepReport): string {
  return `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
}
