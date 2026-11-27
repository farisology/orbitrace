// The history store and its incremental indexer (#25), on temporary copies of the synthetic
// fixture sessions and on hand-written sessions with invented values. Skipped, with the reason in
// the suite name, on a Node without node:sqlite.
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReplay, parseSession, type SessionRef } from "../../src/index.js";
import {
  claudeCodeAdapter,
  deleteHistoryStore,
  HistoryStoreError,
  ingestHistory,
  openHistoryStore,
  type HistoryStore,
} from "../../src/sources/node.js";
import { FAKE, plantedMarkers } from "./secrets.js";
import { loadSqlite } from "../../src/history/engine.js";
import {
  copyAllFixtures,
  copyFixtureSession,
  directLineCount,
  fixtureSessions,
  rawSourceBytes,
  rawStoreBytes,
  sandboxSessions,
  SKIP_NOTE,
  SQLITE_AVAILABLE,
  useSandbox,
  type Sandbox,
} from "./helpers.js";

const sandbox = useSandbox();

const SESSION_ID = "00000000-0000-4000-8000-00000000c0de";
const PROJECT = "-srv-example-project";

/** A synthetic conversation line with invented values. */
function line(n: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: n % 2 === 0 ? "user" : "assistant",
    uuid: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 9, 0, n)).toISOString(),
    sessionId: SESSION_ID,
    message:
      n % 2 === 0
        ? { role: "user", content: `invented prompt number ${n}` }
        : {
            id: `msg_example_${n}`,
            model: "claude-opus-5-5",
            role: "assistant",
            usage: { input_tokens: n, output_tokens: 1 },
            content: [{ type: "text", text: `invented reply ${n}` }],
          },
    ...extra,
  });
}

/** Write a hand-made session into the sandbox. Returns the main transcript path. */
async function writeSession(
  box: Sandbox,
  main: string,
  subagents: { agentId: string; meta: Record<string, unknown> | null; text: string }[] = [],
): Promise<string> {
  const projectDir = join(box.config, "projects", PROJECT);
  await mkdir(projectDir, { recursive: true });
  const transcript = join(projectDir, `${SESSION_ID}.jsonl`);
  await writeFile(transcript, main);
  if (subagents.length > 0) {
    const dir = join(projectDir, SESSION_ID, "subagents");
    await mkdir(dir, { recursive: true });
    for (const sub of subagents) {
      await writeFile(join(dir, `agent-${sub.agentId}.jsonl`), sub.text);
      if (sub.meta !== null) {
        await writeFile(join(dir, `agent-${sub.agentId}.meta.json`), JSON.stringify(sub.meta));
      }
    }
  }
  return transcript;
}

const lines = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => `${line(from + i)}\n`).join("");

async function onlySession(box: Sandbox): Promise<SessionRef> {
  const [ref] = await sandboxSessions(box);
  if (ref === undefined) throw new Error("no session found");
  return ref;
}

async function writer(): Promise<HistoryStore> {
  return openHistoryStore({ mode: "write" });
}

describe.skipIf(!SQLITE_AVAILABLE)(`history ingest${SKIP_NOTE}`, () => {
  it("stores every line once: a second run adds nothing and totals match a direct count", async () => {
    const box = sandbox();
    await copyAllFixtures(box);
    const expected = await directLineCount(box.config);
    const store = await writer();
    try {
      const first = await ingestHistory(store, { roots: [box.root] });
      expect(first.sessions).toBe(fixtureSessions().length);
      expect(first.linesRead).toBe(expected);
      expect(first.linesAdded).toBe(expected);
      expect(first.linesSkipped).toBe(0);
      expect(store.totals().lines).toBe(expected);

      const second = await ingestHistory(store, { roots: [box.root] });
      expect(second.linesAdded).toBe(0);
      expect(second.linesRead).toBe(0);
      expect(second.filesReset).toBe(0);
      expect(store.totals()).toEqual({
        sessions: fixtureSessions().length,
        files: first.files,
        lines: expected,
      });
      const summaries = store.listSessions();
      expect(summaries.reduce((sum, s) => sum + s.lineCount, 0)).toBe(expected);
    } finally {
      store.close();
    }
  });

  it("rebuilds the same replay from the stored lines as from the files", async () => {
    const box = sandbox();
    await copyAllFixtures(box);
    const store = await writer();
    try {
      await ingestHistory(store, { roots: [box.root] });
      for (const ref of await sandboxSessions(box)) {
        const fromFiles = buildReplay(await parseSession(await claudeCodeAdapter.openSession(ref)));
        const stored = store.readSession(ref.key);
        expect(stored).not.toBeNull();
        const fromStore = buildReplay(await parseSession(stored!));
        expect(fromStore).toEqual(fromFiles);
      }
    } finally {
      store.close();
    }
  });

  it("rebuilds the same replay for a session whose lines held secrets, without the secrets", async () => {
    const box = sandbox();
    // A distinct invented value per assignment form, JSON key and meta field, so each one is
    // checked on its own.
    const value = (tag: string, n: number): string => `fake-${tag}-value-${n}-Zq7w`;
    const assignmentForms = [
      `DB_PASSWORD=${value("assign", 0)}`,
      `export SERVICE_SECRET="${value("assign", 1)}"`,
      `{"api_key": "${value("assign", 2)}"}`,
      `password: ${value("assign", 3)}`,
      `client_secret='${value("assign", 4)}'`,
      `access_token=${value("assign", 5)}&next=1`,
      `DB_PASSWORD_PROD=${value("assign", 6)}`,
      `SECRET_KEY_BASE=${value("assign", 7)}`,
      `GITHUB_TOKEN_RW=${value("assign", 8)}`,
      `API_KEY_ID=${value("assign", 9)}`,
      `password_confirmation: ${value("assign", 10)}`,
      `Cookie: sid=${value("assign", 11)}; theme=dark`,
    ];
    const keyed = {
      accessToken: value("key", 0),
      refreshToken: value("key", 1),
      githubToken: value("key", 2),
      SECRET_KEY_BASE: value("key", 3),
      dbPassword: value("key", 4),
      headers: { Cookie: `sid=${value("key", 5)}` },
    };
    const metaValues = [value("meta", 0), value("meta", 1)];
    const extraMarkers = [
      ...assignmentForms.map((_, i) => value("assign", i)),
      ...Object.keys(keyed).map((_, i) => value("key", i)),
      ...metaValues,
    ];
    const tokenEntries = Object.entries(FAKE.tokens);
    const secretLines = [
      line(0, { cwd: "/srv/example-project" }),
      line(1, { note: `Authorization: Bearer ${FAKE.bearer}` }),
      line(2, {
        message: {
          role: "user",
          content: `use ${FAKE.tokens.anthropic} and ${FAKE.urlWithCredentials}`,
        },
      }),
      line(3),
      JSON.stringify({ type: "mode", mode: "default", apiKey: FAKE.password }),
      // Not JSON and holding a secret: skipped. Not JSON and clean: stored.
      `{"type":"user","broken": "${FAKE.tokens.github}`,
      '{"type":"assistant","message":{"id":"msg_cut"',
      line(4, { toolUseResult: FAKE.privateKey }),
      // Every prefixed token format, one per line.
      ...tokenEntries.map(([name, token], i) =>
        line(10 + i, { note: `the ${name} value ${token}` }),
      ),
      // Basic credentials, in a header and loose.
      line(30, { note: `curl -H "Authorization: Basic ${FAKE.basic}" example.com` }),
      line(31, { note: `sent basic ${FAKE.basic} once` }),
      // Every assignment form, one per line.
      ...assignmentForms.map((form, i) => line(40 + i, { note: form })),
      // Secret keys in structured JSON.
      line(60, { mcpArguments: keyed }),
    ];
    await writeSession(box, `${secretLines.join("\n")}\n`, [
      {
        agentId: "a0example1",
        meta: {
          agentType: "example-helper",
          toolUseId: "toolu_none",
          description: `DB_PASSWORD=${FAKE.password}`,
          authToken: metaValues[0],
          notes: `GITHUB_TOKEN_RW=${metaValues[1]} and ${FAKE.tokens.stripe}`,
        },
        text: `${line(5, { isSidechain: true, cmd: `export TOKEN=${FAKE.tokens.slack}` })}\n`,
      },
    ]);
    const markers = [...plantedMarkers(), ...extraMarkers];
    // Every marker really is in the source files, so its absence below means something.
    const source = (await rawSourceBytes(box.config)).toString("latin1");
    expect(markers.filter((marker) => !source.includes(marker))).toEqual([]);
    const ref = await onlySession(box);
    const store = await writer();
    try {
      const result = await ingestHistory(store, { sessions: [ref] });
      const lineCount = 9 + tokenEntries.length + 2 + assignmentForms.length + 1;
      expect(result.linesRead).toBe(lineCount);
      expect(result.linesSkipped).toBe(1);
      expect(result.linesAdded).toBe(lineCount - 1);
      // Bearer, Anthropic key + URL credentials, apiKey value, private key, Slack token (6), one
      // per token format, two Basic, one per assignment form, and six keyed values. The meta
      // file is redacted too but not counted.
      const keyedValues = 6; // five keys plus headers.Cookie
      expect(result.redactions).toBe(
        6 + tokenEntries.length + 2 + assignmentForms.length + keyedValues,
      );
      const stored = store.readSession(ref.key)!;
      const fromStore = buildReplay(await parseSession(stored));
      const fromFiles = buildReplay(await parseSession(await claudeCodeAdapter.openSession(ref)));
      expect(fromStore).toEqual(fromFiles);
      const storedText = JSON.stringify(stored);
      expect(markers.filter((marker) => storedText.includes(marker))).toEqual([]);
      expect(stored.subagents[0]?.meta?.agentType).toBe("example-helper");

      const raw = (await rawStoreBytes(box.data)).toString("latin1");
      expect(existsSync(join(box.data, "history.sqlite-wal"))).toBe(true);
      expect(raw.length).toBeGreaterThan(0);
      // While open (WAL file present) ...
      expect(markers.filter((marker) => raw.includes(marker))).toEqual([]);
    } finally {
      store.close();
    }
    const raw = (await rawStoreBytes(box.data)).toString("latin1");
    // ... and after close (WAL checkpointed into the database).
    expect(markers.filter((marker) => raw.includes(marker))).toEqual([]);
  });

  it("reads only the appended lines on the next run", async () => {
    const box = sandbox();
    const transcript = await writeSession(box, lines(0, 10));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      expect((await ingestHistory(store, { sessions: [ref] })).linesAdded).toBe(10);
      await appendFile(transcript, lines(10, 13));
      const next = await ingestHistory(store, { sessions: [ref] });
      expect(next).toMatchObject({ linesRead: 3, linesAdded: 3, filesReset: 0 });
      expect(store.totals().lines).toBe(13);
      expect(store.readSession(ref.key)?.main).toEqual(lines(0, 13).trimEnd().split("\n"));
    } finally {
      store.close();
    }
  });

  it("runs overlapping ingests on one store one after another: no line is stored twice", async () => {
    const box = sandbox();
    const transcript = await writeSession(box, lines(0, 100));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref] });
      await appendFile(transcript, lines(100, 5000));
      const [a, b] = await Promise.all([
        ingestHistory(store, { sessions: [ref] }, { batchLines: 100 }),
        ingestHistory(store, { sessions: [ref] }, { batchLines: 100 }),
      ]);
      expect(a.linesAdded + b.linesAdded).toBe(4900);
      expect(store.totals().lines).toBe(await directLineCount(box.config));
      expect(store.totals().lines).toBe(5000);
    } finally {
      store.close();
    }
  });

  it("refuses deleteSession and scrub while an ingest runs on the same store", async () => {
    const box = sandbox();
    await writeSession(box, lines(0, 50));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      const refused: unknown[] = [];
      const result = await ingestHistory(
        store,
        { sessions: [ref] },
        {
          batchLines: 10,
          onProgress: () => {
            for (const call of [() => store.deleteSession(ref.key), () => store.scrub()]) {
              try {
                call();
              } catch (error) {
                refused.push(error);
              }
            }
          },
        },
      );
      expect(result.linesAdded).toBe(50);
      expect(refused).toHaveLength(2);
      for (const error of refused) {
        expect(error).toBeInstanceOf(HistoryStoreError);
        expect(error).toMatchObject({ code: "locked" });
      }
      expect(store.deleteSession(ref.key)).toEqual({ deleted: true, scrubbed: true });
    } finally {
      store.close();
    }
  });

  it("leaves a partial last line for the next run", async () => {
    const box = sandbox();
    const full = line(3);
    const transcript = await writeSession(box, `${lines(0, 3)}${full.slice(0, 20)}`);
    const ref = await onlySession(box);
    const store = await writer();
    try {
      expect(await ingestHistory(store, { sessions: [ref] })).toMatchObject({
        linesRead: 3,
        linesAdded: 3,
      });
      expect(await ingestHistory(store, { sessions: [ref] })).toMatchObject({ linesRead: 0 });
      await appendFile(transcript, `${full.slice(20)}\n`);
      expect(await ingestHistory(store, { sessions: [ref] })).toMatchObject({
        linesRead: 1,
        linesAdded: 1,
        filesReset: 0,
      });
      expect(store.readSession(ref.key)?.main.at(-1)).toBe(full);
    } finally {
      store.close();
    }
  });

  it("re-reads a truncated file without duplicating, and keeps the lines it lost", async () => {
    const box = sandbox();
    const transcript = await writeSession(box, lines(0, 10));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref] });
      const keep = Buffer.byteLength(lines(0, 4));
      await truncate(transcript, keep);
      const afterTruncate = await ingestHistory(store, { sessions: [ref] });
      expect(afterTruncate).toMatchObject({ filesReset: 1, linesRead: 4, linesAdded: 0 });
      expect(store.totals().lines).toBe(10);

      await appendFile(transcript, `${line(50)}\n${line(51)}\n`);
      const afterAppend = await ingestHistory(store, { sessions: [ref] });
      expect(afterAppend).toMatchObject({ filesReset: 0, linesRead: 2, linesAdded: 2 });
      expect(store.totals().lines).toBe(12);
      expect(await ingestHistory(store, { sessions: [ref] })).toMatchObject({ linesAdded: 0 });
    } finally {
      store.close();
    }
  });

  it("re-reads a file replaced by a new one without duplicating", async () => {
    const box = sandbox();
    const transcript = await writeSession(box, lines(0, 6));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref] });
      const replacement = `${transcript}.tmp`;
      await writeFile(replacement, lines(0, 7));
      await rename(replacement, transcript);
      const result = await ingestHistory(store, { sessions: [ref] });
      expect(result).toMatchObject({ filesReset: 1, linesRead: 7, linesAdded: 1 });
      expect(store.totals().lines).toBe(7);
    } finally {
      store.close();
    }
  });

  it("re-reads a file rewritten in place when its first bytes changed", async () => {
    const box = sandbox();
    const modeLine = (mode: string) => JSON.stringify({ type: "mode", mode });
    const transcript = await writeSession(box, `${modeLine("default")}\n${lines(1, 5)}`);
    const ref = await onlySession(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref] });
      // Same length and inode, different first line: only a content check can tell.
      await writeFile(transcript, `${modeLine("planned")}\n${lines(1, 5)}`, { flag: "r+" });
      const result = await ingestHistory(store, { sessions: [ref] });
      expect(result).toMatchObject({ filesReset: 1, linesRead: 5, linesAdded: 1 });
      expect(store.totals().lines).toBe(6);
    } finally {
      store.close();
    }
  });

  it("keeps two identical lines without a uuid as two lines, also across a re-read", async () => {
    const box = sandbox();
    const same = JSON.stringify({ type: "queue-operation", operation: "enqueue" });
    const transcript = await writeSession(box, `${same}\n${same}\n${line(1)}\n`);
    const ref = await onlySession(box);
    const store = await writer();
    try {
      expect((await ingestHistory(store, { sessions: [ref] })).linesAdded).toBe(3);
      await appendFile(transcript, `${same}\n`);
      expect((await ingestHistory(store, { sessions: [ref] })).linesAdded).toBe(1);
      // Rewritten with a new first line: read again, and only the new line is added.
      const first = JSON.stringify({ type: "mode", mode: "default" });
      await writeFile(transcript, `${first}\n${same}\n${same}\n${line(1)}\n${same}\n`);
      expect(await ingestHistory(store, { sessions: [ref] })).toMatchObject({
        filesReset: 1,
        linesRead: 5,
        linesAdded: 1,
      });
      expect(store.totals().lines).toBe(5);
    } finally {
      store.close();
    }
  });

  it("keeps a session's stored lines when its files are deleted", async () => {
    const box = sandbox();
    const transcript = await copyFixtureSession(box, "two-waves");
    const [ref] = await sandboxSessions(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref!] });
      const before = store.totals();
      expect(existsSync(transcript)).toBe(true);
      await rm(join(box.config, "projects"), { recursive: true, force: true });
      const result = await ingestHistory(store, { sessions: [ref!] });
      expect(result.filesMissing).toBe(1);
      expect(store.totals()).toEqual(before);
    } finally {
      store.close();
    }
  });

  it("skips another runtime and a missing session it never stored", async () => {
    const box = sandbox();
    const store = await writer();
    try {
      const ghost: SessionRef = {
        key: "claude-code:00000000000000000000000000000000",
        runtime: "claude-code",
        source: box.root,
        projectLabel: "example",
        sessionId: SESSION_ID,
        lastActivity: 0,
        live: "unknown",
        subagentCount: 0,
        locator: join(box.config, "projects", PROJECT, `${SESSION_ID}.jsonl`),
      };
      const other = { ...ghost, key: "other:1", runtime: "other-runtime" } as unknown as SessionRef;
      const result = await ingestHistory(store, { sessions: [ghost, other] });
      expect(result).toMatchObject({ sessions: 0, sessionsSkipped: 2 });
      expect(store.totals().sessions).toBe(0);
    } finally {
      store.close();
    }
  });

  it("reports progress after each session and stops between transactions when aborted", async () => {
    const box = sandbox();
    await copyAllFixtures(box);
    const expected = await directLineCount(box.config);
    const store = await writer();
    try {
      const progress: number[] = [];
      await ingestHistory(
        store,
        { roots: [box.root] },
        { onProgress: (p) => progress.push(p.sessionsDone) },
      );
      expect(progress).toEqual(fixtureSessions().map((_, i) => i + 1));

      const box2 = await deleteAndReopen(store);
      const controller = new AbortController();
      let commits = 0;
      const run = ingestHistory(
        box2,
        { roots: [box.root] },
        {
          batchLines: 10,
          signal: controller.signal,
          testHooks: {
            beforeCommit: () => {
              commits += 1;
              if (commits === 2) controller.abort();
            },
          },
        },
      );
      await expect(run).rejects.toMatchObject({ code: "aborted" });
      const partial = box2.totals().lines;
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(expected);
      const rest = await ingestHistory(box2, { roots: [box.root] });
      expect(rest.linesAdded).toBe(expected - partial);
      expect(box2.totals().lines).toBe(expected);
      box2.close();
    } finally {
      store.close();
    }
  });

  it("rejects a reader and a closed store", async () => {
    const box = sandbox();
    await writeSession(box, lines(0, 2));
    const ref = await onlySession(box);
    const store = await writer();
    await ingestHistory(store, { sessions: [ref] });
    store.close();
    store.close();
    await expect(ingestHistory(store, { sessions: [ref] })).rejects.toMatchObject({
      code: "not-writable",
    });
    const reader = await openHistoryStore({ mode: "read" });
    try {
      await expect(ingestHistory(reader, { sessions: [ref] })).rejects.toMatchObject({
        code: "not-writable",
      });
      expect(() => reader.deleteSession(ref.key)).toThrow(HistoryStoreError);
      expect(reader.totals().lines).toBe(2);
    } finally {
      reader.close();
    }
  });
});

/** Delete the whole store behind an open writer and open a fresh writer. */
async function deleteAndReopen(store: HistoryStore): Promise<HistoryStore> {
  store.close();
  expect(await deleteHistoryStore()).toBe(true);
  return writer();
}

describe.skipIf(!SQLITE_AVAILABLE)(`history store${SKIP_NOTE}`, () => {
  it("lets a reader read while the writer holds the lock and is inside a transaction", async () => {
    const box = sandbox();
    await writeSession(box, lines(0, 5));
    const ref = await onlySession(box);
    const store = await writer();
    try {
      await ingestHistory(store, { sessions: [ref] });
      const reader = await openHistoryStore({ mode: "read" });
      try {
        expect(reader.totals().lines).toBe(5);
        await appendFile(ref.locator, lines(5, 8));
        let seenInside = -1;
        await ingestHistory(
          store,
          { sessions: [ref] },
          { testHooks: { beforeCommit: () => (seenInside = reader.totals().lines) } },
        );
        expect(seenInside).toBe(5);
        expect(reader.totals().lines).toBe(8);
        expect(reader.listSessions().map((s) => s.key)).toEqual([ref.key]);
      } finally {
        reader.close();
      }
    } finally {
      store.close();
    }
  });

  it("fails a reader with not-found when there is no store, and writes nothing", async () => {
    const box = sandbox();
    await expect(openHistoryStore({ mode: "read" })).rejects.toMatchObject({ code: "not-found" });
    expect(existsSync(box.data)).toBe(false);
  });

  it("refuses a file that is not a history store", async () => {
    const box = sandbox();
    await mkdir(box.data, { recursive: true });
    await writeFile(
      join(box.data, "history.sqlite"),
      "this is not a database file at all".repeat(10),
    );
    await expect(writer()).rejects.toMatchObject({ code: "not-a-store" });
    expect(existsSync(join(box.data, "history.lock"))).toBe(false);
  });

  it("lists sessions with their counts, newest first", async () => {
    const box = sandbox();
    await copyFixtureSession(box, "two-waves");
    await copyFixtureSession(box, "single-agent");
    const store = await writer();
    try {
      await ingestHistory(store, { roots: [box.root] }, { now: () => 1_000 });
      const listed = store.listSessions();
      expect(listed).toHaveLength(2);
      expect(listed[0]!.lastActivity).toBeGreaterThanOrEqual(listed[1]!.lastActivity);
      const twoWaves = fixtureSessions().find((s) => s.name === "two-waves")!;
      const entry = listed.find((s) => s.sessionId === twoWaves.sessionId)!;
      expect(entry).toMatchObject({
        runtime: "claude-code",
        firstIngestedAt: 1_000,
        subagentCount: 5,
      });
      expect(store.readSession("claude-code:missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("deletes one session for real: its bytes are gone from the files", async () => {
    const box = sandbox();
    const marker = "invented-marker-for-deletion-7f3a";
    await writeSession(box, `${line(0, { note: marker })}\n${lines(1, 4)}`);
    await copyFixtureSession(box, "single-agent");
    const refs = await sandboxSessions(box);
    const doomed = refs.find((ref) => ref.sessionId === SESSION_ID)!;
    const store = await writer();
    try {
      await ingestHistory(store, { roots: [box.root] });
      expect((await rawStoreBytes(box.data)).includes(marker)).toBe(true);
      const before = store.totals();
      expect(store.deleteSession(doomed.key)).toEqual({ deleted: true, scrubbed: true });
      expect(store.deleteSession(doomed.key)).toEqual({ deleted: false, scrubbed: true });
      expect(store.readSession(doomed.key)).toBeNull();
      expect(store.totals().sessions).toBe(before.sessions - 1);
      expect(store.totals().lines).toBe(before.lines - 4);
      expect((await rawStoreBytes(box.data)).includes(marker)).toBe(false);
    } finally {
      store.close();
    }
    expect((await rawStoreBytes(box.data)).includes(marker)).toBe(false);
  });

  it("reports an incomplete scrub while a reader is inside a read, and scrub finishes it", async () => {
    const box = sandbox();
    const marker = "invented-marker-for-scrub-5b1c";
    await writeSession(box, `${line(0, { note: marker })}\n${lines(1, 4)}`);
    const ref = await onlySession(box);
    const store = await writer();
    const { module: sqlite } = await loadSqlite();
    const reader = new sqlite!.DatabaseSync(join(box.data, "history.sqlite"));
    try {
      await ingestHistory(store, { sessions: [ref] });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM lines").get();
      const started = Date.now();
      expect(store.deleteSession(ref.key)).toEqual({ deleted: true, scrubbed: false });
      // A few short attempts, not the 5 s busy timeout of ordinary statements.
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(store.readSession(ref.key)).toBeNull();
      expect(store.scrub()).toBe(false);
      reader.exec("COMMIT");
      expect(store.scrub()).toBe(true);
      expect(statSync(join(box.data, "history.sqlite-wal")).size).toBe(0);
      expect((await rawStoreBytes(box.data)).includes(marker)).toBe(false);
    } finally {
      reader.close();
      store.close();
    }
  });

  it("deletes the whole store, and refuses while another writer holds it", async () => {
    const box = sandbox();
    await writeSession(box, lines(0, 3));
    const store = await writer();
    await ingestHistory(store, { roots: [box.root] });
    await expect(deleteHistoryStore()).rejects.toMatchObject({ code: "locked" });
    store.close();
    expect(await deleteHistoryStore()).toBe(true);
    expect(existsSync(box.data)).toBe(false);
    expect(await deleteHistoryStore()).toBe(false);
  });

  it("keeps other files in a data folder the user chose when deleting the store", async () => {
    const box = sandbox();
    await mkdir(box.data, { recursive: true });
    await writeFile(join(box.data, "keep.txt"), "user file");
    const store = await writer();
    store.close();
    expect(await deleteHistoryStore()).toBe(true);
    expect(await readFile(join(box.data, "keep.txt"), "utf8")).toBe("user file");
    expect(existsSync(join(box.data, "history.sqlite"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("makes the folder 0700 and every file 0600", async () => {
    const box = sandbox();
    await writeSession(box, lines(0, 3));
    const store = await writer();
    try {
      await ingestHistory(store, { roots: [box.root] });
      const mode = (path: string) => statSync(path).mode & 0o777;
      expect(mode(box.data)).toBe(0o700);
      const files = ["history.sqlite", "history.sqlite-wal", "history.sqlite-shm", "history.lock"];
      expect(files.map((name) => [name, mode(join(box.data, name))])).toEqual(
        files.map((name) => [name, 0o600]),
      );
    } finally {
      store.close();
    }
  });
});
