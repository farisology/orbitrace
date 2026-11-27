// The ingest in a worker thread (#25), started from the built worker entry
// (`dist/history/worker.js`), on temporary copies of the synthetic fixtures. Skipped, with the
// reason, without node:sqlite.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  openHistoryStore,
  runHistoryIngestWorker,
  type HistoryIngestProgress,
} from "../../src/sources/node.js";
import {
  copyAllFixtures,
  directLineCount,
  DIST_WORKER,
  fixtureSessions,
  requireDist,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  useSandbox,
} from "./helpers.js";

const sandbox = useSandbox();

describe("runHistoryIngestWorker", () => {
  it("rejects with io when the worker file cannot be loaded, and writes nothing", async () => {
    const box = sandbox();
    const missing = pathToFileURL(join(box.base, "no-such-worker.js"));
    await expect(
      runHistoryIngestWorker({ roots: [box.root] }, { workerUrl: missing }),
    ).rejects.toMatchObject({ code: "io" });
    expect(existsSync(box.data)).toBe(false);
  });

  it("rejects with aborted, without starting a worker, when the signal already fired", async () => {
    const box = sandbox();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runHistoryIngestWorker(
        { roots: [box.root] },
        { workerUrl: pathToFileURL(DIST_WORKER), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
  });
});

describe.skipIf(!SQLITE_AVAILABLE)(`history ingest worker${SKIP_NOTE}`, () => {
  it("runs the ingest off the main thread, reports progress and a result, and is idempotent", async () => {
    requireDist();
    const box = sandbox();
    await copyAllFixtures(box);
    const expected = await directLineCount(box.config);
    const workerUrl = pathToFileURL(DIST_WORKER);
    const progress: HistoryIngestProgress[] = [];
    const first = await runHistoryIngestWorker(
      { roots: [box.root] },
      { workerUrl, onProgress: (p) => progress.push(p) },
    );
    expect(first.linesAdded).toBe(expected);
    expect(progress.map((p) => p.sessionsDone)).toEqual(fixtureSessions().map((_, i) => i + 1));
    expect(progress.at(-1)?.linesAdded).toBe(expected);
    expect(existsSync(join(box.data, "history.lock"))).toBe(false);

    const second = await runHistoryIngestWorker({ roots: [box.root] }, { workerUrl });
    expect(second.linesAdded).toBe(0);

    const reader = await openHistoryStore({ mode: "read" });
    expect(reader.totals().lines).toBe(expected);
    reader.close();
  }, 30_000);

  it("reports the store's error by code", async () => {
    requireDist();
    const box = sandbox();
    const holder = await openHistoryStore({ mode: "write" });
    try {
      await expect(
        runHistoryIngestWorker({ roots: [box.root] }, { workerUrl: pathToFileURL(DIST_WORKER) }),
      ).rejects.toMatchObject({ code: "locked" });
    } finally {
      holder.close();
    }
  });

  it("stops when aborted, removes the worker's lock, and a later run completes", async () => {
    requireDist();
    const box = sandbox();
    await copyAllFixtures(box);
    const expected = await directLineCount(box.config);
    const workerUrl = pathToFileURL(DIST_WORKER);
    const controller = new AbortController();
    const run = runHistoryIngestWorker(
      { roots: [box.root] },
      {
        workerUrl,
        batchLines: 5,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      },
    );
    await expect(run).rejects.toMatchObject({ code: "aborted" });
    expect(existsSync(join(box.data, "history.lock"))).toBe(false);

    const store = await openHistoryStore({ mode: "write" });
    const partial = store.totals().lines;
    store.close();
    expect(partial).toBeLessThan(expected);
    const rest = await runHistoryIngestWorker({ roots: [box.root] }, { workerUrl });
    expect(rest.linesAdded).toBe(expected - partial);
  }, 30_000);

  it("removes the lock when aborted after the worker took it but before it reported anything", async () => {
    requireDist();
    const box = sandbox();
    await copyAllFixtures(box);
    const lockFile = join(box.data, "history.lock");
    const controller = new AbortController();
    const run = runHistoryIngestWorker(
      { roots: [box.root] },
      {
        workerUrl: pathToFileURL(DIST_WORKER),
        signal: controller.signal,
        testHooks: { blockAfterLock: true },
      },
    );
    // The worker blocks for good once it holds the lock; abort as soon as the lock file is there.
    const deadline = Date.now() + 15_000;
    while (!existsSync(lockFile) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(existsSync(lockFile)).toBe(true);
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: "aborted" });
    expect(readdirSync(box.data).filter((name) => name.startsWith("history.lock"))).toEqual([]);
    const next = await openHistoryStore({ mode: "write" });
    next.close();
  }, 30_000);

  it("leaves no lock behind when aborted at any moment after the start", async () => {
    requireDist();
    const box = sandbox();
    await copyAllFixtures(box);
    const workerUrl = pathToFileURL(DIST_WORKER);
    for (let delay = 0; delay <= 60; delay += 4) {
      const controller = new AbortController();
      const run = runHistoryIngestWorker(
        { roots: [box.root] },
        { workerUrl, batchLines: 5, signal: controller.signal },
      );
      if (delay === 0) setImmediate(() => controller.abort());
      else setTimeout(() => controller.abort(), delay);
      const outcome = await run.then(
        () => "finished",
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(["finished", "aborted"]).toContain(outcome);
      expect(existsSync(join(box.data, "history.lock"))).toBe(false);
    }
    const next = await openHistoryStore({ mode: "write" });
    next.close();
  }, 60_000);
});
