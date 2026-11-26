/**
 * Renderer demo page. Acts as the host: it owns the replay clock and calls `setTime` every
 * frame while playing, as the app (#11) will. All data is synthetic (see demo-model.ts).
 */

import type { ReplayModel } from "@orbitrace/core";
import { createOrrery, type OrreryHandle } from "../src/index.js";
import { runBenchmark } from "./bench.js";
import { createDemoModel, snapshotAt } from "./demo-model.js";

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

let full: ReplayModel = createDemoModel();
let live = false;
let time = 0;
let playing = false;
let speed = Number(speedSelect.value);
let lastFrame = -1;
let lastSnapshot = -Infinity;
const intervals: number[] = [];

function duration(): number {
  return full.totals.duration;
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
  handle.setModel(live ? snapshotAt(full, time) : full);
  handle.setTime(time);
  if (playing) handle.play();
  return handle;
}

let handle = makeHandle(null);

function loadSession(): void {
  const kind = sessionSelect.value;
  full =
    kind === "large"
      ? createDemoModel({ seed: 9, waves: 6, agentsPerWave: 12 })
      : createDemoModel();
  live = kind === "live";
  time = 0;
  lastSnapshot = -Infinity;
  handle.setModel(live ? snapshotAt(full, 0) : full);
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
      if (live && time - lastSnapshot >= 1) {
        handle.updateModel(snapshotAt(full, time));
        lastSnapshot = time;
      }
      handle.setTime(time);
      if (time >= duration()) setPlaying(false);
    }
  }
  lastFrame = now;
  scrub.value = String(Math.round((time / duration()) * 1000));
  clock.textContent = `${time.toFixed(1)} s / ${duration().toFixed(0)} s`;
  if (intervals.length > 0) {
    const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    hud.textContent = `${(1000 / avg).toFixed(0)} fps (host loop)\n${full.agents.length} agents, ${full.totals.toolCalls} calls`;
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
  if (live) handle.updateModel(snapshotAt(full, time));
  handle.setTime(time);
});
sessionSelect.addEventListener("change", loadSession);
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
  handle.select(preselect as "main" | `a${number}`);
  selectedLabel.textContent = `selected: ${preselect}`;
}

if (params.has("bench")) {
  const out = $<HTMLPreElement>("bench");
  out.hidden = false;
  out.textContent = "benchmark running...";
  handle.destroy();
  const result = runBenchmark(canvas);
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
