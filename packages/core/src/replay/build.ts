/**
 * Ticket #8: the replay model builder. Turns a `ParsedSession` into a structure-only
 * `ReplayModel` v1. Pure and synchronous: no I/O, no clock, no randomness, so the same input
 * always gives the same output.
 *
 * Steps:
 * 1. Take a snapshot at `now`: replies and calls that start after it are left out; ends after
 *    it count as not seen yet, so the agent or call stays open (`end: null`).
 * 2. Find idle gaps from busy intervals (subagent lifetimes, tool call spans, and
 *    `replyPaddingSeconds` around each reply) and cut them (see `timeline.ts`).
 * 3. Number subagents `a1`, `a2`, ... by the start of the parent call that started them, give
 *    callsigns and waves, and copy tool calls and replies onto the compressed timeline. A
 *    linked subagent starts at that call (its dispatch), so its `start` is the same in every
 *    live snapshot, including one taken before its own first line was written.
 *
 * Nothing that identifies the session or holds content is copied: runtime agent ids, tool use
 * ids, message ids and the session id are used for linking only, and every string written is
 * kept only when it already matches the schema's identifier patterns and is otherwise replaced
 * by a fixed label (see `names.ts`).
 */

import { REPLAY_BUILD_DEFAULTS, type BuildReplay, type BuildReplayOptions } from "../api.js";
import type {
  ParsedReply,
  ParsedRun,
  ParsedSession,
  ParsedSubagentRun,
  ParsedToolCall,
} from "../model/parsed.js";
import {
  REPLAY_FORMAT_VERSION,
  type EffortLevel,
  type ModelFamily,
  type ReplayAgentId,
  type ReplayMainAgent,
  type ReplayModel,
  type ReplayReply,
  type ReplayReplyDetails,
  type ReplayReplyWithDetails,
  type ReplaySubagent,
  type ReplayToolCall,
  type ReplayTotals,
  type ReplayWarp,
} from "../model/replay.js";
import {
  agentNameOf,
  assignCallsigns,
  dominant,
  effortOf,
  familyOf,
  modelIdOf,
  toolKindOf,
  toolLabelOf,
} from "./names.js";
import { Timeline, cutsFromWarps, findCuts, mergeLiveCuts, type Interval } from "./timeline.js";

/**
 * Seconds of busy time counted before the first line and after the last line of each reply
 * when finding idle gaps. The prototype used "a few seconds"; 3 s keeps a reply that
 * stands alone (no tool call) from being swallowed by a cut next to it.
 */
export const DEFAULT_REPLY_PADDING_SECONDS = 3;

/** Every option of `buildReplay` with its default filled in, `now` and `previous` excepted. */
export const REPLAY_BUILD_DEFAULTS_RESOLVED = {
  ...REPLAY_BUILD_DEFAULTS,
  replyPaddingSeconds: DEFAULT_REPLY_PADDING_SECONDS,
} as const;

interface ResolvedOptions {
  readonly gapMs: number;
  readonly keepMs: number;
  readonly waveGapMs: number;
  readonly padMs: number;
  readonly now: number | undefined;
  readonly previous: ReplayModel | undefined;
  /** `BuildReplayOptions.replyDetails`. */
  readonly details: boolean;
}

function seconds(name: string, value: number | undefined, fallback: number): number {
  const chosen = value ?? fallback;
  if (!Number.isFinite(chosen) || chosen < 0) {
    throw new RangeError(
      `buildReplay: option ${name} must be a finite number of seconds, 0 or more`,
    );
  }
  return Math.round(chosen * 1000);
}

function resolveOptions(options: BuildReplayOptions | undefined): ResolvedOptions {
  const defaults = REPLAY_BUILD_DEFAULTS_RESOLVED;
  const now = options?.now;
  if (now !== undefined && !Number.isFinite(now)) {
    throw new RangeError("buildReplay: option now must be a finite epoch time in milliseconds");
  }
  return {
    gapMs: seconds("idleGapSeconds", options?.idleGapSeconds, defaults.idleGapSeconds),
    keepMs: seconds("idleKeepSeconds", options?.idleKeepSeconds, defaults.idleKeepSeconds),
    waveGapMs: seconds("waveGapSeconds", options?.waveGapSeconds, defaults.waveGapSeconds),
    padMs: seconds(
      "replyPaddingSeconds",
      options?.replyPaddingSeconds,
      defaults.replyPaddingSeconds,
    ),
    now: now === undefined ? undefined : Math.round(now),
    previous: options?.previous,
    details: options?.replyDetails === true,
  };
}

// ---------------------------------------------------------------------------------------
// Snapshot: the part of each run visible at `now`, in absolute milliseconds.
// ---------------------------------------------------------------------------------------

interface SnapCall {
  readonly source: ParsedToolCall;
  readonly start: number;
  /** `null` when no result was seen by `now`. */
  readonly end: number | null;
  readonly failed: boolean;
}

interface SnapReply {
  readonly first: number;
  readonly last: number;
  readonly source: ParsedReply;
}

interface SnapRun {
  readonly calls: readonly SnapCall[];
  readonly replies: readonly SnapReply[];
  /** First time of the run, or `null` when it has none visible. */
  readonly first: number | null;
  /** Last time of the run seen by `now`, or `null`. */
  readonly last: number | null;
  /** The run wrote lines after `now`. */
  readonly continuesAfterNow: boolean;
}

const ms = (value: number): number => Math.round(value);

/** Smallest value, or `null` for an empty list. A loop, so long sessions cannot overflow the stack. */
function minOf(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) if (best === null || value < best) best = value;
  return best;
}

/** Largest value, or `null` for an empty list. */
function maxOf(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) if (best === null || value > best) best = value;
  return best;
}

function timesOf(run: ParsedRun): number[] {
  const times: number[] = [];
  if (run.startedAt !== null) times.push(ms(run.startedAt));
  if (run.endedAt !== null) times.push(ms(run.endedAt));
  for (const reply of run.replies) times.push(ms(reply.firstAt), ms(reply.lastAt));
  for (const call of run.toolCalls) {
    times.push(ms(call.startedAt));
    if (call.endedAt !== null) times.push(ms(call.endedAt));
  }
  return times;
}

function snapRun(run: ParsedRun, now: number): SnapRun {
  const calls = run.toolCalls
    .map((source, index) => ({ source, index, start: ms(source.startedAt) }))
    .filter((call) => call.start <= now)
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map(({ source, start }): SnapCall => {
      const ended = source.endedAt === null ? null : ms(source.endedAt);
      const end = ended !== null && ended <= now ? Math.max(ended, start) : null;
      return { source, start, end, failed: end !== null && source.isError === true };
    });
  const replies = run.replies
    .map((source, index) => ({ source, index, first: ms(source.firstAt) }))
    .filter((reply) => reply.first <= now)
    .sort((a, b) => a.first - b.first || a.index - b.index)
    .map(({ source, first }): SnapReply => ({
      source,
      first,
      last: Math.min(Math.max(ms(source.lastAt), first), now),
    }));
  const all = timesOf(run);
  const visible = all.filter((time) => time <= now);
  return {
    calls,
    replies,
    first: minOf(visible),
    last: maxOf(visible),
    continuesAfterNow: all.some((time) => time > now),
  };
}

// ---------------------------------------------------------------------------------------
// Subagent linking and ordering.
// ---------------------------------------------------------------------------------------

/** Where the call that started a subagent was found. `run` is `-1` for the main run. */
interface ParentCall {
  readonly run: number;
  readonly call: ParsedToolCall;
  readonly callIndex: number;
  readonly blockIndex: number;
}

function blockIndexOf(run: ParsedRun, call: ParsedToolCall): number {
  const reply = run.replies.find((candidate) => candidate.messageId === call.messageId);
  const index = reply?.toolUseIds.indexOf(call.toolUseId) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function findParentCall(session: ParsedSession, subIndex: number): ParentCall | null {
  const sub = session.subagents[subIndex] as ParsedSubagentRun;
  const runs: { run: number; data: ParsedRun; agentId: string }[] = [
    { run: -1, data: session.main, agentId: "main" },
    ...session.subagents.map((data, run) => ({ run, data, agentId: data.agentId })),
  ];
  // Search the run named as parent first, then every other run, so a wrong parent id still links.
  const ordered = [
    ...runs.filter((entry) => entry.agentId === sub.parentAgentId),
    ...runs.filter((entry) => entry.agentId !== sub.parentAgentId),
  ];
  const matchers: ((call: ParsedToolCall) => boolean)[] = [];
  if (sub.parentToolUseId !== null) {
    const id = sub.parentToolUseId;
    matchers.push((call) => call.toolUseId === id);
  }
  matchers.push((call) => call.spawnedAgentId === sub.agentId);
  for (const matches of matchers) {
    for (const entry of ordered) {
      if (entry.run === subIndex) continue;
      const callIndex = entry.data.toolCalls.findIndex(matches);
      const call = entry.data.toolCalls[callIndex];
      if (call !== undefined) {
        return { run: entry.run, call, callIndex, blockIndex: blockIndexOf(entry.data, call) };
      }
    }
  }
  return null;
}

/**
 * Fresh numbering order of subagents (indexes into `session.subagents`): linked ones by the
 * parent call's start, then `tool_use` block order, then call order; unlinked ones after, in
 * session order.
 */
function freshOrder(
  indexes: readonly number[],
  parents: ReadonlyMap<number, ParentCall>,
): number[] {
  const linked = indexes.filter((index) => parents.has(index));
  const unlinked = indexes.filter((index) => !parents.has(index));
  linked.sort((a, b) => {
    const pa = parents.get(a) as ParentCall;
    const pb = parents.get(b) as ParentCall;
    return (
      ms(pa.call.startedAt) - ms(pb.call.startedAt) ||
      pa.blockIndex - pb.blockIndex ||
      pa.run - pb.run ||
      pa.callIndex - pb.callIndex ||
      a - b
    );
  });
  return [...linked, ...unlinked];
}

// ---------------------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------------------

interface Draft {
  /** Index in `session.subagents`, or `-1` for the main agent. */
  readonly index: number;
  readonly name: string;
  readonly start: number;
  readonly end: number | null;
  readonly snap: SnapRun;
  readonly model: string | null;
  readonly effort: EffortLevel | null;
  /** Index of the parent run, `-1` for main. */
  readonly parentRun: number;
}

function sumTotals(
  tools: readonly ReplayToolCall[],
  replies: readonly ReplayReply[],
): ReplayTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const reply of replies) {
    inputTokens += reply.inputTokens;
    outputTokens += reply.outputTokens;
    cacheReadTokens += reply.cacheReadTokens;
    cacheCreationTokens += reply.cacheCreationTokens;
  }
  return {
    toolCalls: tools.length,
    failedToolCalls: tools.filter((tool) => tool.failed).length,
    replies: replies.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
}

const count = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * The in-memory details of one reply (#190, #191): only what the transcript recorded, so a
 * missing split or model stays absent instead of becoming 0 or a guess. The model goes through
 * the same identifier check as an agent's model.
 */
export function replyDetailsOf(reply: ParsedReply): ReplayReplyDetails {
  const { cacheWrite5mTokens, cacheWrite1hTokens } = reply.usage;
  const model = modelIdOf(reply.model);
  return {
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens: count(cacheWrite5mTokens) }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens: count(cacheWrite1hTokens) }),
    ...(model === null ? {} : { model }),
  };
}

class Assembler {
  constructor(
    private readonly timeline: Timeline,
    private readonly t0: number,
    /** Write each reply's in-memory details (`BuildReplayOptions.replyDetails`). */
    private readonly details: boolean,
  ) {}

  /** Absolute milliseconds to compressed seconds. */
  at(absolute: number): number {
    return this.timeline.compress(absolute - this.t0) / 1000;
  }

  tools(snap: SnapRun): ReplayToolCall[] {
    return snap.calls.map((call) => {
      const kind = toolKindOf(call.source.kind);
      return {
        name: toolLabelOf(call.source.name, kind, call.source.mcpServer),
        kind,
        start: this.at(call.start),
        end: call.end === null ? null : this.at(call.end),
        failed: call.failed,
      };
    });
  }

  replies(snap: SnapRun): ReplayReplyWithDetails[] {
    return snap.replies.map((reply) => {
      const base: ReplayReply = {
        t: this.at(reply.first),
        inputTokens: count(reply.source.usage.inputTokens),
        outputTokens: count(reply.source.usage.outputTokens),
        cacheReadTokens: count(reply.source.usage.cacheReadTokens),
        cacheCreationTokens: count(reply.source.usage.cacheCreationTokens),
      };
      return this.details ? { ...base, ...replyDetailsOf(reply.source) } : base;
    });
  }
}

interface Identity {
  readonly id: `a${number}`;
  readonly callsign: string | null;
  readonly name: string;
  readonly wave: number | null;
  readonly parent: ReplayAgentId | null;
  readonly previous: ReplaySubagent | null;
}

/** Raised inside a live build when `previous` does not describe this session. */
class StalePrevious extends Error {}

function isUsablePrevious(previous: ReplayModel | undefined): previous is ReplayModel {
  return (
    previous !== undefined &&
    previous.formatVersion === REPLAY_FORMAT_VERSION &&
    Array.isArray(previous.agents) &&
    previous.agents.length > 0 &&
    Array.isArray(previous.warps)
  );
}

/** `prior` entries are a prefix of `next`, compared by `same`. */
function isPrefix<T>(
  prior: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean,
): boolean {
  return prior.length <= next.length && prior.every((item, i) => same(item, next[i] as T));
}

/**
 * One-to-one assignment of previous subagents to visible subagents (augmenting paths). `edges`
 * lists, for a previous subagent, its candidates in order of preference. Returns, per previous
 * subagent, the picked candidate, or `null` when not every previous subagent can be placed.
 * Deterministic: previous subagents are placed in id order and candidates tried in the order given.
 */
function assignAll(count: number, edges: (prior: number) => readonly number[]): number[] | null {
  const owner = new Map<number, number>();
  const place = (prior: number, seen: Set<number>): boolean => {
    for (const candidate of edges(prior)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const current = owner.get(candidate);
      if (current === undefined || place(current, seen)) {
        owner.set(candidate, prior);
        return true;
      }
    }
    return false;
  };
  for (let prior = 0; prior < count; prior += 1) {
    if (!place(prior, new Set())) return null;
  }
  const picks: number[] = new Array<number>(count);
  for (const [candidate, prior] of owner) picks[prior] = candidate;
  return picks;
}

/**
 * Match the subagents of the previous snapshot to the visible subagents of this one. A match
 * needs the same compressed `start`. Subagents started by one reply share that start, so the
 * content decides between them: the previous `tools` and `replies` must be a prefix of the
 * candidate's (append stability rule (c)). When no full match of that kind exists (late data
 * placed inside a cut), a match on `start` alone is used. Among candidates, the same name is
 * preferred, then fresh order. Returns indexes into `session.subagents`, one per previous
 * subagent, or `null` when `previous` does not describe this session.
 */
function matchPrevious(
  prevSubs: readonly ReplaySubagent[],
  order: readonly number[],
  drafts: ReadonlyMap<number, Draft>,
  assembler: Assembler,
): number[] | null {
  const content = new Map<number, { tools: ReplayToolCall[]; replies: ReplayReply[] }>();
  const contentOf = (index: number): { tools: ReplayToolCall[]; replies: ReplayReply[] } => {
    let found = content.get(index);
    if (found === undefined) {
      const snap = (drafts.get(index) as Draft).snap;
      found = { tools: assembler.tools(snap), replies: assembler.replies(snap) };
      content.set(index, found);
    }
    return found;
  };
  const sameStart = prevSubs.map((prior) => {
    const candidates = order.filter(
      (index) => assembler.at((drafts.get(index) as Draft).start) === prior.start,
    );
    return [
      ...candidates.filter((index) => (drafts.get(index) as Draft).name === prior.name),
      ...candidates.filter((index) => (drafts.get(index) as Draft).name !== prior.name),
    ];
  });
  const consistent = prevSubs.map((prior, position) =>
    (sameStart[position] as number[]).filter((index) => {
      const next = contentOf(index);
      return (
        isPrefix(
          prior.tools,
          next.tools,
          (a, b) => a.name === b.name && a.kind === b.kind && a.start === b.start,
        ) && isPrefix(prior.replies, next.replies, (a, b) => a.t === b.t)
      );
    }),
  );
  return (
    assignAll(prevSubs.length, (prior) => consistent[prior] as number[]) ??
    assignAll(prevSubs.length, (prior) => sameStart[prior] as number[])
  );
}

function build(session: ParsedSession, options: ResolvedOptions, live: boolean): ReplayModel {
  const allTimes = [...timesOf(session.main), ...session.subagents.flatMap((sub) => timesOf(sub))];
  const now = options.now ?? maxOf(allTimes) ?? 0;
  const visibleTimes = allTimes.filter((time) => time <= now);
  const t0 = minOf(visibleTimes) ?? now;
  const horizon = (maxOf(visibleTimes) ?? t0) - t0;

  // Snapshot of every run, and which subagents are visible at `now`.
  const mainSnap = snapRun(session.main, now);
  const parents = new Map<number, ParentCall>();
  session.subagents.forEach((_, index) => {
    const parent = findParentCall(session, index);
    if (parent !== null) parents.set(index, parent);
  });
  // A linked subagent starts at its dispatch: the parent call's start, or its own first line
  // when that is earlier (clock skew). This value is the same in every snapshot the subagent
  // is visible in, so it does not jump when the subagent's first line arrives after the call.
  const subSnaps = session.subagents.map((sub, index) => {
    const snap = snapRun(sub, now);
    const parent = parents.get(index);
    const start =
      parent === undefined
        ? snap.first
        : Math.min(ms(parent.call.startedAt), snap.first ?? Infinity);
    return { sub, snap, start };
  });
  const visible = subSnaps
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.start !== null && entry.start <= now)
    .map((entry) => entry.index);
  const visibleSet = new Set(visible);

  const callOpen = (call: ParsedToolCall | undefined): boolean => {
    if (call === undefined || ms(call.startedAt) > now) return false;
    return call.endedAt === null || ms(call.endedAt) > now;
  };

  // Subagent drafts, keyed by index in `session.subagents`.
  const drafts = new Map<number, Draft>();
  for (const index of visible) {
    const entry = subSnaps[index] as (typeof subSnaps)[number];
    const parent = parents.get(index);
    const start = entry.start as number;
    const open =
      entry.snap.continuesAfterNow ||
      entry.snap.calls.some((call) => call.end === null) ||
      callOpen(parent?.call);
    const lastSeen = Math.max(start, entry.snap.last ?? start);
    const parentRun = parent !== undefined && visibleSet.has(parent.run) ? parent.run : -1;
    drafts.set(index, {
      index,
      name: agentNameOf(entry.sub.agentType),
      start,
      end: open ? null : lastSeen,
      snap: entry.snap,
      model:
        dominant(entry.snap.replies.map((reply) => modelIdOf(reply.source.model))) ??
        modelIdOf(entry.sub.model),
      effort: dominant(entry.snap.replies.map((reply) => effortOf(reply.source.effort))),
      parentRun,
    });
  }

  const anythingOpen =
    mainSnap.continuesAfterNow ||
    mainSnap.calls.some((call) => call.end === null) ||
    [...drafts.values()].some((draft) => draft.end === null);
  const mainStart = mainSnap.first ?? t0;

  // Idle compression.
  const busy: Interval[] = [];
  const rel = (time: number): number => time - t0;
  for (const draft of drafts.values()) {
    busy.push({ start: rel(draft.start), end: draft.end === null ? horizon : rel(draft.end) });
  }
  for (const snap of [mainSnap, ...[...drafts.values()].map((draft) => draft.snap)]) {
    for (const call of snap.calls) {
      busy.push({ start: rel(call.start), end: call.end === null ? horizon : rel(call.end) });
    }
    for (const reply of snap.replies) {
      busy.push({ start: rel(reply.first) - options.padMs, end: rel(reply.last) + options.padMs });
    }
  }
  const fresh = findCuts(busy, horizon, options.gapMs, options.keepMs);
  let cuts = fresh;
  const previous = live && isUsablePrevious(options.previous) ? options.previous : undefined;
  if (previous !== undefined) {
    const kept = cutsFromWarps(previous.warps);
    const lastKept = kept[kept.length - 1];
    if (lastKept !== undefined && lastKept.end > horizon) throw new StalePrevious();
    cuts = mergeLiveCuts(kept, fresh);
  }
  const timeline = new Timeline(cuts);
  const assembler = new Assembler(timeline, t0, options.details);

  // Numbering. Previous agents keep their ids; new ones follow in fresh order.
  const order = freshOrder(visible, parents);
  const identities = new Map<number, Identity>();
  const prevSubs = (previous?.agents.slice(1) ?? []) as ReplaySubagent[];
  if (previous !== undefined) {
    if (previous.agents[0].start !== assembler.at(mainStart)) throw new StalePrevious();
    const picks = matchPrevious(prevSubs, order, drafts, assembler);
    if (picks === null) throw new StalePrevious();
    prevSubs.forEach((prior, position) => {
      const pick = picks[position] as number;
      identities.set(pick, {
        id: prior.id,
        callsign: prior.callsign,
        name: prior.name,
        wave: prior.wave,
        parent: prior.parent,
        previous: prior,
      });
    });
  }
  // Sort into id order: previous agents by their old id, new ones after in fresh order.
  const idNumber = (id: string): number => Number(id.slice(1));
  const known = order
    .filter((index) => identities.has(index))
    .sort(
      (a, b) =>
        idNumber((identities.get(a) as Identity).id) - idNumber((identities.get(b) as Identity).id),
    );
  const fresher = order.filter((index) => !identities.has(index));
  const idOrder = [...known, ...fresher];
  let nextId = prevSubs.length + 1;
  for (const index of fresher) {
    identities.set(index, {
      id: `a${nextId}`,
      callsign: null,
      name: (drafts.get(index) as Draft).name,
      wave: null,
      parent: null,
      previous: null,
    });
    nextId += 1;
  }

  const idOf = (run: number): ReplayAgentId =>
    run === -1 ? "main" : (identities.get(run) as Identity).id;
  const callsigns = assignCallsigns(
    ["main", ...idOrder.map((index) => (identities.get(index) as Identity).name)],
    ["main", ...idOrder.map((index) => (identities.get(index) as Identity).callsign)],
  );

  // Waves, in id order, from compressed starts.
  const waveGap = options.waveGapMs / 1000;
  let wave = -1;
  let latestStart = -Infinity;
  const waves = idOrder.map((index) => {
    const identity = identities.get(index) as Identity;
    const start = assembler.at((drafts.get(index) as Draft).start);
    const assigned =
      identity.wave ?? (wave < 0 ? 0 : start > latestStart + waveGap ? wave + 1 : wave);
    wave = Math.max(wave, assigned);
    latestStart = Math.max(latestStart, start);
    return assigned;
  });

  // Main agent.
  const mainTools = assembler.tools(mainSnap);
  const mainReplies = assembler.replies(mainSnap);
  const mainModel = dominant(mainSnap.replies.map((reply) => modelIdOf(reply.source.model)));
  const prevMain = previous?.agents[0];
  const mainAgent: ReplayMainAgent = {
    id: "main",
    name: "main",
    callsign: "main",
    ...stableModel(mainModel, prevMain),
    effort:
      prevMain?.effort ?? dominant(mainSnap.replies.map((reply) => effortOf(reply.source.effort))),
    parent: null,
    wave: null,
    start: assembler.at(mainStart),
    end: anythingOpen ? null : assembler.at(Math.max(mainStart, mainSnap.last ?? mainStart)),
    tools: mainTools,
    replies: mainReplies,
    totals: sumTotals(mainTools, mainReplies),
  };

  const subagents: ReplaySubagent[] = idOrder.map((index, position) => {
    const draft = drafts.get(index) as Draft;
    const identity = identities.get(index) as Identity;
    const parent = idOf(draft.parentRun);
    if (identity.previous !== null && identity.parent !== parent) throw new StalePrevious();
    const tools = assembler.tools(draft.snap);
    const replies = assembler.replies(draft.snap);
    return {
      id: identity.id,
      name: identity.name,
      callsign: callsigns[position + 1] as string,
      ...stableModel(draft.model, identity.previous),
      effort: identity.previous?.effort ?? draft.effort,
      parent,
      wave: waves[position] as number,
      start: assembler.at(draft.start),
      end: draft.end === null ? null : assembler.at(draft.end),
      tools,
      replies,
      totals: sumTotals(tools, replies),
    };
  });

  const agents: [ReplayMainAgent, ...ReplaySubagent[]] = [mainAgent, ...subagents];
  const warps: ReplayWarp[] = timeline
    .warpsMs()
    .map((warp) => ({ at: warp.at / 1000, skipped: warp.skipped / 1000 }));
  const sum = (key: keyof ReplayTotals): number =>
    agents.reduce((total, agent) => total + agent.totals[key], 0);
  const duration = assembler.at(t0 + horizon);
  const skipped = warps.reduce((total, warp) => total + warp.skipped, 0);

  return {
    formatVersion: REPLAY_FORMAT_VERSION,
    agents,
    warps,
    totals: {
      agents: agents.length,
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      duration,
      realDuration: duration + skipped,
    },
  };
}

/**
 * Model and family of an agent. In a live build a model already shown is kept, so a value
 * only fills in from `null` (or a family from `unknown`) between snapshots.
 */
function stableModel(
  model: string | null,
  previous: { readonly model: string | null; readonly family: ModelFamily } | null | undefined,
): { model: string | null; family: ModelFamily } {
  const chosen = previous?.model ?? model;
  const derived = familyOf(chosen);
  const family =
    previous !== null && previous !== undefined && previous.family !== "unknown"
      ? previous.family
      : derived;
  return { model: chosen, family };
}

/**
 * Build a replay model from a parsed session. See `BuildReplay` in `api.ts` for the contract
 * and `docs/replay-format.md` for the rules the result keeps.
 *
 * Throws `RangeError` only for an invalid option (a negative or non-finite number). A
 * `previous` snapshot that does not describe this session is ignored and a fresh build is
 * made.
 */
export const buildReplay: BuildReplay = (session, options) => {
  const resolved = resolveOptions(options);
  if (resolved.previous === undefined) return build(session, resolved, false);
  try {
    return build(session, resolved, true);
  } catch (error) {
    if (error instanceof StalePrevious) return build(session, resolved, false);
    throw error;
  }
};
