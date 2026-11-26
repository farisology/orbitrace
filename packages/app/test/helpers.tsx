// Shared test helpers: a hand-built synthetic replay, a fake renderer and a fake host.
// Every value here is invented.

import type {
  LiveStatus,
  ReplayAgentId,
  ReplayMainAgent,
  ReplayModel,
  ReplaySubagent,
  ReplayToolCall,
  ReplayTotals,
  SessionSummary,
} from "@orbitrace/core";
import type { OrreryEventName, OrreryHandle, OrreryListener } from "@orbitrace/renderer";
import { vi } from "vitest";
import type { OrreryFactory } from "../src/components/OrreryView";
import type { HostTransport, LiveUpdate, LiveUpdateListener } from "../src/transport";
import type { FrameScheduler } from "../src/use-clock";
import demoJson from "../src/generated/demo.replay.json";

/** The bundled demo golden replay, as the app ships it. */
export const DEMO = demoJson as unknown as ReplayModel;

function tool(
  name: string,
  kind: ReplayToolCall["kind"],
  start: number,
  end: number | null,
  failed = false,
): ReplayToolCall {
  return { name, kind, start, end, failed };
}

function totalsOf(tools: readonly ReplayToolCall[], outputTokens: number): ReplayTotals {
  return {
    toolCalls: tools.length,
    failedToolCalls: tools.filter((t) => t.failed).length,
    replies: 1,
    inputTokens: 10,
    outputTokens,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
  };
}

/**
 * A small valid replay: main plus two subagents in one wave, one idle skip at t = 30, two
 * failed calls close together. `duration` sets the timeline length (for live snapshots).
 */
export function makeModel(duration = 60): ReplayModel {
  const mainTools = [
    tool("Read", "read", 1, 2),
    tool("Agent", "agent", 4, 20),
    tool("Agent", "agent", 4.5, 22),
    tool("Bash", "shell", 25, 26, true),
    tool("Edit", "edit", 40, 41),
  ];
  const a1Tools = [
    tool("Grep", "read", 6, 7),
    tool("Bash", "shell", 8, 9),
    tool("Bash", "shell", 27, 28, true),
  ];
  const a2Tools = [tool("mcp:widget-docs", "mcp", 10, 11), tool("Write", "edit", 12, null)];
  const main: ReplayMainAgent = {
    id: "main",
    name: "main",
    callsign: "main",
    model: "claude-opus-5-5",
    family: "opus",
    effort: "high",
    parent: null,
    wave: null,
    start: 0,
    end: duration,
    tools: mainTools,
    replies: [
      { t: 0.5, inputTokens: 10, outputTokens: 300, cacheReadTokens: 100, cacheCreationTokens: 50 },
    ],
    totals: totalsOf(mainTools, 300),
  };
  const a1: ReplaySubagent = {
    id: "a1",
    name: "widget-explorer",
    callsign: "widget-explorer",
    model: "claude-haiku-4-5",
    family: "haiku",
    effort: "low",
    parent: "main",
    wave: 0,
    start: 4,
    end: 20,
    tools: a1Tools,
    replies: [
      { t: 5, inputTokens: 10, outputTokens: 1200, cacheReadTokens: 100, cacheCreationTokens: 50 },
    ],
    totals: totalsOf(a1Tools, 1200),
  };
  const a2: ReplaySubagent = {
    id: "a2",
    name: "gadget-builder",
    callsign: "gadget-builder",
    model: "claude-sonnet-4-6",
    family: "sonnet",
    effort: null,
    parent: "main",
    wave: 0,
    start: 4.5,
    end: null,
    tools: a2Tools,
    replies: [
      { t: 5, inputTokens: 10, outputTokens: 40, cacheReadTokens: 100, cacheCreationTokens: 50 },
    ],
    totals: totalsOf(a2Tools, 40),
  };
  const agents = [main, a1, a2] as const;
  const sum = (key: keyof ReplayTotals) => agents.reduce((s, a) => s + a.totals[key], 0);
  const warps = [{ at: 30, skipped: 600 }];
  return {
    formatVersion: 1,
    agents: [main, a1, a2],
    warps,
    totals: {
      toolCalls: sum("toolCalls"),
      failedToolCalls: sum("failedToolCalls"),
      replies: sum("replies"),
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      cacheReadTokens: sum("cacheReadTokens"),
      cacheCreationTokens: sum("cacheCreationTokens"),
      agents: 3,
      duration,
      realDuration: duration + 600,
    },
  };
}

export type OrreryCall = { readonly method: string; readonly args: readonly unknown[] };

export interface FakeOrrery {
  readonly factory: OrreryFactory;
  readonly calls: OrreryCall[];
  readonly handles: OrreryHandle[];
  /** Emit a renderer event on the newest handle, as a click on the canvas would. */
  emit<E extends OrreryEventName>(event: E, payload: Parameters<OrreryListener<E>>[0]): void;
  /** Names of the calls made, in order. */
  methods(): string[];
  /** Arguments of the last call to `method`. */
  last(method: string): readonly unknown[] | undefined;
}

/** A renderer stand-in that records every call. The real one needs a 2D canvas. */
export function fakeOrrery(): FakeOrrery {
  const calls: OrreryCall[] = [];
  const handles: OrreryHandle[] = [];
  const listeners: Map<string, Set<(payload: unknown) => void>>[] = [];
  const factory: OrreryFactory = (_canvas, options) => {
    calls.push({ method: "create", args: [options] });
    const own = new Map<string, Set<(payload: unknown) => void>>();
    listeners.push(own);
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args });
      };
    const handle: OrreryHandle = {
      setModel: record("setModel"),
      updateModel: record("updateModel"),
      setTime: record("setTime"),
      play: record("play"),
      pause: record("pause"),
      setSpeed: record("setSpeed"),
      select: record("select"),
      resize: record("resize"),
      destroy: record("destroy"),
      on(event, listener) {
        const set = own.get(event) ?? new Set();
        set.add(listener as (payload: unknown) => void);
        own.set(event, set);
        return () => set.delete(listener as (payload: unknown) => void);
      },
    };
    handles.push(handle);
    return handle;
  };
  return {
    factory,
    calls,
    handles,
    emit(event, payload) {
      const own = listeners[listeners.length - 1];
      for (const listener of own?.get(event) ?? []) listener(payload);
    },
    methods: () => calls.map((call) => call.method),
    last(method) {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];
        if (call !== undefined && call.method === method) return call.args;
      }
      return undefined;
    },
  };
}

/** Frames that never fire: the clock moves only when a test moves it. */
export const stillFrames: FrameScheduler = { request: () => 1, cancel: () => {} };

/** Frames a test fires by hand. */
export function manualFrames(): FrameScheduler & { fire(now: number): void; pending(): number } {
  let queue: ((now: number) => void)[] = [];
  return {
    request(callback) {
      queue.push(callback);
      return queue.length;
    },
    cancel() {
      queue = [];
    },
    fire(now) {
      const current = queue;
      queue = [];
      for (const callback of current) callback(now);
    },
    pending: () => queue.length,
  };
}

export const SUMMARY: SessionSummary = {
  key: "session-1",
  runtime: "claude-code",
  projectLabel: "example-project",
  sessionId: "synthetic-session",
  lastActivity: 1,
  live: "busy",
  subagentCount: 2,
};

/** A host whose updates the test pushes by hand. */
export interface ScriptedHost extends HostTransport {
  push(update: LiveUpdate): void;
  readonly subscribed: string[];
  readonly unsubscribed: number;
}

export function scriptedHost(sessions: readonly SessionSummary[] = [SUMMARY]): ScriptedHost {
  let listener: LiveUpdateListener | null = null;
  const subscribed: string[] = [];
  let unsubscribed = 0;
  return {
    kind: "browser",
    canOpenInBrowser: false,
    listSessions: vi.fn(async () => sessions),
    loadReplay: vi.fn(async () => makeModel()),
    subscribe(key, next) {
      subscribed.push(key);
      listener = next;
      return () => {
        unsubscribed += 1;
        if (listener === next) listener = null;
      };
    },
    openInBrowser: vi.fn(async () => {}),
    push(update) {
      listener?.(update);
    },
    subscribed,
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

export function replayUpdate(model: ReplayModel, live: LiveStatus = "busy"): LiveUpdate {
  return { type: "replay", replay: model, live };
}

export function agentIds(model: ReplayModel): ReplayAgentId[] {
  return model.agents.map((agent) => agent.id);
}
