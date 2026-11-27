/**
 * Renderer demo page. Acts as the host: it owns the replay clock and calls `setTime` every
 * frame while playing, as the app does. Every session is synthetic: the fixtures generator
 * writes a transcript and core's `parseSession` and `buildReplay` turn it into the replay
 * (see sessions.ts), so the page shows what the real pipeline produces (#77).
 */

import {
  buildReplay,
  toRealSeconds,
  type ParsedSession,
  type ReplayAgentId,
  type ReplayModel,
} from "@orbitrace/core";
import { createOrrery, type OrreryHandle } from "../src/index.js";
import { runBenchmark } from "./bench.js";
import { demoSession, parseGenerated, scaledSession, sessionStartMs } from "./sessions.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("orrery");
const playButton = $<HTMLButtonElement>("play");
const speedSelect = $<HTMLSelectElement>("speed");
const scrub = $<HTMLInputElement>("scrub");
const clock = $<HTMLSpanElement>("clock");
const sessionSelect = $<HTMLSelectElement>("session");
const reducedBox = $<HTMLInputElement>("reduced");
const selectedLabel = $<HTMLSpanElement>("selected");
const hud = $<HTMLDivElement>("hud");

const params = new URLSearchParams(location.search);
reducedBox.checked = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The session on show: its parsed form (for live snapshots) and its full replay. */
interface Shown {
  readonly parsed: ParsedSession;
  readonly full: ReplayModel;
  readonly startMs: number;
}

const SCALED: Readonly<Record<string, number>> = { large: 100, huge: 500 };

async function load(kind: string): Promise<Shown> {
  const agents = SCALED[kind];
  const session = agents === undefined ? demoSession() : scaledSession(agents);
  const parsed = await parseGenerated(session);
  return { parsed, full: buildReplay(parsed), startMs: sessionStartMs(parsed) };
}

// ?session=large (100 agents) or ?session=huge (500 agents) starts with a scaled session.
const firstKind =
  SCALED[params.get("session") ?? ""] === undefined ? "demo" : params.get("session")!;
sessionSelect.value = firstKind;
let shown: Shown = await load(firstKind);
let live = false;
let lastSnapshot: ReplayModel | null = null;
let time = 0;
let playing = false;
let speed = Number(speedSelect.value);
let lastFrame = -1;
let lastSnapshotTime = -Infinity;
const intervals: number[] = [];

function duration(): number {
  return shown.full.totals.duration;
}

/**
 * A live snapshot at replay time `t`: `buildReplay` with `now` at the matching real time, and
 * the previous snapshot when time moved forward, as a host watching a session does.
 */
function snapshotAt(t: number): ReplayModel {
  const now = shown.startMs + toRealSeconds(shown.full.warps, t) * 1000;
  const previous =
    lastSnapshot !== null && t >= lastSnapshotTime ? { previous: lastSnapshot } : undefined;
  lastSnapshot = buildReplay(shown.parsed, { now, ...previous });
  lastSnapshotTime = t;
  return lastSnapshot;
}

/** Make a renderer on the canvas, replacing `previous`, with the current state applied. */
function makeHandle(previous: OrreryHandle | null): OrreryHandle {
  previous?.destroy();
  const handle = createOrrery(canvas, { reducedMotion: reducedBox.checked });
  const rect = canvas.getBoundingClientRect();
  handle.resize(rect.width, rect.height);
  handle.setSpeed(speed);
  handle.on("select", ({ agentId }) => {
    handle.select(agentId);
    selectedLabel.textContent = `selected: ${agentId ?? "none"}`;
  });
  handle.on("hover", ({ agentId }) => {
    canvas.title = agentId ?? "";
  });
  handle.setModel(live ? snapshotAt(time) : shown.full);
  handle.setTime(time);
  if (playing) handle.play();
  return handle;
}

let handle = makeHandle(null);

async function loadSession(): Promise<void> {
  const kind = sessionSelect.value;
  shown = await load(kind === "live" ? "demo" : kind);
  live = kind === "live";
  time = 0;
  lastSnapshot = null;
  lastSnapshotTime = -Infinity;
  handle.setModel(live ? snapshotAt(0) : shown.full);
  handle.setTime(0);
  selectedLabel.textContent = "selected: none";
}

function setPlaying(next: boolean): void {
  playing = next;
  playButton.textContent = next ? "Pause" : "Play";
  if (next) {
    if (time >= duration()) time = 0;
    handle.play();
  } else {
    handle.pause();
  }
}

function frame(now: number): void {
  if (lastFrame >= 0) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    intervals.push(now - lastFrame);
    if (intervals.length > 120) intervals.shift();
    if (playing) {
      time = Math.min(duration(), time + dt * speed);
      if (live && time - lastSnapshotTime >= 1) handle.updateModel(snapshotAt(time));
      handle.setTime(time);
      if (time >= duration()) setPlaying(false);
    }
  }
  lastFrame = now;
  scrub.value = String(Math.round((time / duration()) * 1000));
  clock.textContent = `${time.toFixed(1)} s / ${duration().toFixed(0)} s`;
  if (intervals.length > 0) {
    const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    hud.textContent = `${(1000 / avg).toFixed(0)} fps (host loop)\n${shown.full.agents.length} agents, ${shown.full.totals.toolCalls} calls`;
  }
  requestAnimationFrame(frame);
}

playButton.addEventListener("click", () => setPlaying(!playing));
speedSelect.addEventListener("change", () => {
  speed = Number(speedSelect.value);
  handle.setSpeed(speed);
});
scrub.addEventListener("input", () => {
  time = (Number(scrub.value) / 1000) * duration();
  if (live) handle.updateModel(snapshotAt(time));
  handle.setTime(time);
});
sessionSelect.addEventListener("change", () => void loadSession());
reducedBox.addEventListener("change", () => {
  if (reducedBox.checked) setPlaying(false);
  handle = makeHandle(handle);
});
new ResizeObserver(() => {
  const rect = canvas.getBoundingClientRect();
  handle.resize(rect.width, rect.height);
}).observe(canvas);

// ?t=<seconds> starts at that replay time; ?select=<agent id> selects an agent.
time = params.has("t") ? Math.min(duration(), Number(params.get("t")) || 0) : duration() * 0.3;
handle.setTime(time);
const preselect = params.get("select");
if (preselect !== null && /^(main|a\d+)$/.test(preselect)) {
  handle.select(preselect as ReplayAgentId);
  selectedLabel.textContent = `selected: ${preselect}`;
}

if (params.has("bench")) {
  const out = $<HTMLPreElement>("bench");
  out.hidden = false;
  out.textContent = "benchmark running...";
  handle.destroy();
  const counts = (params.get("agents") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  const result = runBenchmark(canvas, counts.length > 0 ? counts : undefined);
  (window as unknown as { __orbitraceBench: Promise<unknown> }).__orbitraceBench = result;
  void result.then((r) => {
    out.textContent = JSON.stringify(r, null, 2);
    handle = makeHandle(handle);
  });
} else {
  // Reduced motion: no autoplay.
  if (!reducedBox.checked && !params.has("paused")) setPlaying(true);
  requestAnimationFrame(frame);
}
