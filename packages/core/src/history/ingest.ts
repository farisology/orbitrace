/// <reference types="node" />
/**
 * The incremental indexer of the history store (ticket #25): copies the transcript lines of
 * sessions into an open writer store, redacted, so a second run reads only what was appended.
 *
 * Per transcript file (the main transcript and each `subagents/agent-<id>.jsonl`):
 * - The file row keeps the byte offset read up to. A run reads from there to the end and stores
 *   each complete line (one ending in `\n`). A last line without its `\n` is left for the next
 *   run, so a line Claude Code is still writing is never stored half done.
 * - Before reading, the file is checked against what was stored: its device and inode, its size
 *   against the offset, and hashes of its first and last 4 KiB before the offset. A different
 *   inode or changed bytes means the file was replaced; a size below the offset means it was
 *   truncated. Either way it is read again from the start under a new generation, and every line
 *   already stored is recognised by its key and not stored twice. Lines that are no longer in the
 *   file stay stored: the store keeps history.
 * - A line's key is its `uuid` when it has one, otherwise a hash of its redacted text, plus a
 *   count of earlier lines in the same file with the same key. So two identical lines are both
 *   kept, and a re-read finds each again.
 * - Lines are written in transactions of `batchLines`, each together with the new offset, so a
 *   process killed mid-run loses nothing and duplicates nothing: the next run starts at the
 *   last committed offset.
 * - Blank lines are skipped. A byte order mark at the very start is removed.
 *
 * Redaction (see `redact.ts`) happens before a line is written: a JSON line is parsed, walked
 * and stored re-serialised with its secrets replaced. A line that is not JSON is stored as it is
 * only when the same rules find nothing in it as text; otherwise it is counted in
 * `linesSkipped` and not stored.
 *
 * A file that is missing is skipped, and what was stored from it stays. A session whose main
 * transcript is missing and that was never stored is skipped.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import type { SessionRef, SourceRoot } from "../model/sources.js";
import { claudeCodeAdapter, CLAUDE_CODE_RUNTIME } from "../sources/claude-code/adapter.js";
import { pathApiForPath } from "../sources/claude-code/paths.js";
import { listSessions } from "../sources/index.js";
import { HistoryStoreError } from "./errors.js";
import { redactJsonValue, redactText } from "./redact.js";
import {
  SqliteHistoryStore,
  type HistoryFileRow,
  type HistoryFileState,
  type HistoryStore,
} from "./store.js";

/** What to ingest. Plain data, so a worker can receive it as a message. */
export interface HistoryIngestRequest {
  /** These sessions. */
  readonly sessions?: readonly SessionRef[];
  /** Every session under these roots, listed with the Claude Code adapter. */
  readonly roots?: readonly SourceRoot[];
}

/** Progress after each session. */
export interface HistoryIngestProgress {
  readonly sessionsDone: number;
  readonly sessionsTotal: number;
  readonly linesAdded: number;
}

/** What one run did. */
export interface HistoryIngestResult {
  /** Sessions read. */
  readonly sessions: number;
  /** Sessions not read: another runtime, or a main transcript that is missing and never stored. */
  readonly sessionsSkipped: number;
  /** Transcript files read. */
  readonly files: number;
  /** Transcript files that could not be opened (deleted, or unreadable). */
  readonly filesMissing: number;
  /** Files found truncated or replaced and read again from the start. */
  readonly filesReset: number;
  /** Complete, non-blank lines read in this run. */
  readonly linesRead: number;
  /** Lines stored for the first time. */
  readonly linesAdded: number;
  /** Lines that are not JSON and in which a redaction rule matched: not stored. */
  readonly linesSkipped: number;
  /** Strings replaced by redaction in the lines read. */
  readonly redactions: number;
  readonly durationMs: number;
}

export interface HistoryIngestOptions {
  readonly onProgress?: (progress: HistoryIngestProgress) => void;
  /** Stops the run between two transactions with `aborted`. Committed lines stay. */
  readonly signal?: AbortSignal;
  /** Lines per transaction. Default 1000. */
  readonly batchLines?: number;
  /** Clock for the ingest times, Unix epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** For tests only: called inside each transaction, just before it commits. */
  readonly testHooks?: { readonly beforeCommit?: () => void };
}

/** A line ready to store, or a line that must not be stored. */
export type PreparedHistoryLine =
  | {
      readonly kind: "store";
      readonly baseKey: string;
      readonly text: string;
      readonly redactions: number;
    }
  | { readonly kind: "skip" };

const WINDOW_BYTES = 4096;
const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;
const BYTE_ORDER_MARK = 0xfeff;
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Redact one transcript line and give its base key. A JSON line is stored re-serialised with its
 * secrets replaced; a line that is not JSON is stored only when no rule matches it as text.
 */
export function prepareHistoryLine(text: string): PreparedHistoryLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const checked = redactText(text);
    if (checked.count > 0) return { kind: "skip" };
    return { kind: "store", baseKey: `h:${sha256(text).slice(0, 32)}`, text, redactions: 0 };
  }
  const redacted = redactJsonValue(parsed);
  const json = JSON.stringify(redacted.value);
  const value = redacted.value;
  const uuid =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as { uuid?: unknown }).uuid
      : undefined;
  const baseKey =
    typeof uuid === "string" && uuid !== "" ? `u:${uuid}` : `h:${sha256(json).slice(0, 32)}`;
  return { kind: "store", baseKey, text: json, redactions: redacted.count };
}

interface Counters {
  /** The read buffer, shared by every file of one run. */
  readonly chunk: Buffer;
  sessions: number;
  sessionsSkipped: number;
  files: number;
  filesMissing: number;
  filesReset: number;
  linesRead: number;
  linesAdded: number;
  linesSkipped: number;
  redactions: number;
}

interface PendingLine {
  readonly baseKey: string;
  readonly occurrence: number;
  readonly text: string;
}

function readWindow(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const bytesRead = readSync(fd, buffer, done, length - done, start + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buffer.subarray(0, done);
}

function windowHash(fd: number, start: number, length: number): string {
  return sha256(readWindow(fd, start, length));
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new HistoryStoreError("aborted", "The history ingest was stopped.");
  }
}

/** Let other work on this thread run between files and transactions. */
const yieldToEventLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

/**
 * Ingest one transcript file into its row. File reads are synchronous (each is small, and a run
 * of many small asynchronous reads spent most of its time waiting); the function yields to the
 * event loop between transactions, so a caller on the main thread is not blocked for long.
 */
async function ingestFile(
  store: SqliteHistoryStore,
  row: HistoryFileRow,
  filePath: string,
  counters: Counters,
  options: HistoryIngestOptions,
): Promise<void> {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    counters.filesMissing += 1;
    return;
  }
  try {
    counters.files += 1;
    const info = fstatSync(fd);
    const dev = String(info.dev);
    const ino = String(info.ino);
    let generation = row.generation;
    let offset = row.offset;
    let headLen = row.headLen;
    let headHash = row.headHash;
    let reset = false;
    if (row.dev !== null && (row.dev !== dev || row.ino !== ino)) reset = true;
    else if (info.size < row.offset) reset = true;
    else if (row.headLen > 0 && windowHash(fd, 0, row.headLen) !== row.headHash) reset = true;
    else if (
      row.tailLen > 0 &&
      windowHash(fd, row.offset - row.tailLen, row.tailLen) !== row.tailHash
    )
      reset = true;
    if (reset) {
      counters.filesReset += 1;
      generation += 1;
      offset = 0;
      headLen = 0;
      headHash = null;
    }
    // Reading from the start of a generation sees every earlier line itself; only a run that
    // continues a generation must ask the store how often a key was already seen.
    const continuing = offset > 0;

    const batchLines = Math.max(1, Math.floor(options.batchLines ?? 1000));
    const occurrences = new Map<string, number>();
    let batch: PendingLine[] = [];
    let stateDirty = reset || row.dev === null;

    const commit = async (endOffset: number): Promise<void> => {
      checkAbort(options.signal);
      if (headLen < WINDOW_BYTES && endOffset > headLen) {
        headLen = Math.min(endOffset, WINDOW_BYTES);
        headHash = windowHash(fd, 0, headLen);
      }
      const tailLen = Math.min(endOffset, WINDOW_BYTES);
      const tailHash = tailLen > 0 ? windowHash(fd, endOffset - tailLen, tailLen) : null;
      const state: HistoryFileState = {
        dev,
        ino,
        offset: endOffset,
        headLen,
        headHash,
        tailLen,
        tailHash,
        generation,
      };
      const lines = batch;
      batch = [];
      store.assertWritable();
      const added = store.transaction(() => {
        let count = 0;
        for (const line of lines) {
          if (store.putLine(row.id, line.baseKey, line.occurrence, generation, line.text)) {
            count += 1;
          }
        }
        store.setFileState(row.id, state);
        options.testHooks?.beforeCommit?.();
        return count;
      });
      counters.linesAdded += added;
      offset = endOffset;
      stateDirty = false;
      await yieldToEventLoop();
    };

    const take = (bytes: Buffer, startOffset: number): void => {
      let text = bytes.toString("utf8");
      if (startOffset === 0 && text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
      if (text.endsWith("\r")) text = text.slice(0, -1);
      if (text.trim() === "") return;
      counters.linesRead += 1;
      const prepared = prepareHistoryLine(text);
      if (prepared.kind === "skip") {
        counters.linesSkipped += 1;
        return;
      }
      counters.redactions += prepared.redactions;
      const seen =
        occurrences.get(prepared.baseKey) ??
        (continuing ? store.occurrencesSeen(row.id, prepared.baseKey, generation) : 0);
      occurrences.set(prepared.baseKey, seen + 1);
      batch.push({ baseKey: prepared.baseKey, occurrence: seen + 1, text: prepared.text });
    };

    const chunk = counters.chunk;
    let position = offset;
    // Bytes of the line being read that came in earlier chunks, and where that line starts.
    let partial: Buffer[] = [];
    let lineStart = offset;
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const at = data.indexOf(NEWLINE, from);
        if (at < 0) break;
        const piece = data.subarray(from, at);
        const bytes = partial.length === 0 ? piece : Buffer.concat([...partial, piece]);
        partial = [];
        take(bytes, lineStart);
        lineStart = position + at + 1;
        stateDirty = true;
        from = at + 1;
        if (batch.length >= batchLines) await commit(lineStart);
      }
      if (from < bytesRead) partial.push(Buffer.from(data.subarray(from)));
      position += bytesRead;
    }
    if (batch.length > 0 || stateDirty || lineStart !== offset) await commit(lineStart);
  } finally {
    closeSync(fd);
  }
}

/** The subagent transcripts of a Claude Code session: agent id, transcript and meta paths. */
function subagentFiles(ref: SessionRef): { agentId: string; transcript: string; meta: string }[] {
  const p = pathApiForPath(ref.locator);
  const dir = p.join(p.dirname(ref.locator), ref.sessionId, "subagents");
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const result: { agentId: string; transcript: string; meta: string }[] = [];
  for (const name of names) {
    const agentId = SUBAGENT_FILE.exec(name)?.[1];
    if (agentId === undefined) continue;
    result.push({
      agentId,
      transcript: p.join(dir, name),
      meta: p.join(dir, `agent-${agentId}.meta.json`),
    });
  }
  return result;
}

/** The redacted meta file as JSON text, or null when it is missing or not a JSON object. */
function readMeta(file: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return JSON.stringify(redactJsonValue(parsed).value);
}

/**
 * Copy the lines of sessions into a writer store. Reads each transcript from where the last run
 * stopped, so a second run with nothing new adds nothing. Throws `not-writable` for a reader or
 * a closed store, `locked` when the store's lock was lost, and `aborted` when `signal` fires.
 *
 * Calls on the same store run one after another: a call made while another is running waits for
 * it to end and then reads from where it stopped, so overlapping calls (a timer and a file-change
 * event, say) never store a line twice.
 */
export async function ingestHistory(
  store: HistoryStore,
  request: HistoryIngestRequest,
  options: HistoryIngestOptions = {},
): Promise<HistoryIngestResult> {
  if (!(store instanceof SqliteHistoryStore)) {
    throw new HistoryStoreError("not-writable", "Not a store opened with openHistoryStore.");
  }
  store.assertWritable();
  return store.exclusiveWrite(() => runIngest(store, request, options));
}

async function runIngest(
  store: SqliteHistoryStore,
  request: HistoryIngestRequest,
  options: HistoryIngestOptions,
): Promise<HistoryIngestResult> {
  store.assertWritable();
  const started = Date.now();
  const now = options.now ?? Date.now;
  const counters: Counters = {
    chunk: Buffer.allocUnsafe(CHUNK_BYTES),
    sessions: 0,
    sessionsSkipped: 0,
    files: 0,
    filesMissing: 0,
    filesReset: 0,
    linesRead: 0,
    linesAdded: 0,
    linesSkipped: 0,
    redactions: 0,
  };
  const refs: SessionRef[] = [...(request.sessions ?? [])];
  if (request.roots !== undefined && request.roots.length > 0) {
    refs.push(...(await listSessions(request.roots, [claudeCodeAdapter])));
  }
  const seen = new Set<string>();
  const unique = refs.filter((ref) => !seen.has(ref.key) && seen.add(ref.key));

  let done = 0;
  for (const ref of unique) {
    checkAbort(options.signal);
    if (ref.runtime !== CLAUDE_CODE_RUNTIME) {
      counters.sessionsSkipped += 1;
    } else if (!existsSync(ref.locator) && !store.hasSession(ref.key)) {
      counters.sessionsSkipped += 1;
    } else {
      counters.sessions += 1;
      const sessionRowId = store.upsertSession(
        {
          key: ref.key,
          runtime: ref.runtime,
          sessionId: ref.sessionId,
          projectLabel: ref.projectLabel,
          lastActivity: ref.lastActivity,
        },
        now(),
      );
      await ingestFile(
        store,
        store.fileRow(sessionRowId, "main", ""),
        ref.locator,
        counters,
        options,
      );
      for (const sub of subagentFiles(ref)) {
        const row = store.fileRow(sessionRowId, "subagent", sub.agentId);
        const meta = readMeta(sub.meta);
        if (meta !== null && meta !== row.meta) store.setFileMeta(row.id, meta);
        await ingestFile(store, row, sub.transcript, counters, options);
      }
    }
    done += 1;
    await yieldToEventLoop();
    options.onProgress?.({
      sessionsDone: done,
      sessionsTotal: unique.length,
      linesAdded: counters.linesAdded,
    });
  }
  return {
    sessions: counters.sessions,
    sessionsSkipped: counters.sessionsSkipped,
    files: counters.files,
    filesMissing: counters.filesMissing,
    filesReset: counters.filesReset,
    linesRead: counters.linesRead,
    linesAdded: counters.linesAdded,
    linesSkipped: counters.linesSkipped,
    redactions: counters.redactions,
    durationMs: Date.now() - started,
  };
}
