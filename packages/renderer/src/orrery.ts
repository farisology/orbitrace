/**
 * The engine behind `createOrrery`. It wires a canvas, pointer input and a frame scheduler
 * to the pure parts (scene, layout, timeline, hit testing) and the drawing code.
 *
 * Time: the host owns the replay clock and calls `setTime`. The engine never advances
 * replay time. Its only clock is the frame scheduler, used for ambient motion (stars,
 * flowing dashes, breathing halos) while the host reports that it is playing. Effects with
 * a real-time length (comets, pulses, the minimum visible time of short calls, the warp) are
 * a pure function of the time and the speed, so they stop when the host stops calling
 * `setTime`. With reduced motion the scheduler draws one still frame per change and the
 * ambient clock never moves.
 *
 * Per-agent transient state: every effect is derived from the model and the time, so there
 * is no per-agent animation state to lose or carry. `updateModel` keeps the selection and the
 * hover by agent id; `setModel` clears both.
 */

import type { ReplayAgentId, ReplayModel } from "@orbitrace/core";
import type {
  CreateOrrery,
  OrreryEventName,
  OrreryEvents,
  OrreryHandle,
  OrreryListener,
  OrreryOptions,
} from "./api.js";
import type { DrawContext, OrreryEnvironment, SpriteSurface } from "./context.js";
import { drawFrame, type ViewState } from "./draw.js";
import { hitTestAgents } from "./hit.js";
import { computeLayout, createLayout, type Layout } from "./layout.js";
import { createResources } from "./resources.js";
import { buildScene, type Scene } from "./scene.js";
import { createPalette, resolveTheme } from "./theme.js";
import {
  computeFrameState,
  createFrameState,
  DEFAULT_MIN_VISIBLE_CALL_SECONDS,
  frameFits,
  type FrameState,
} from "./timeline.js";

/** Longest real-time step the ambient clock takes in one frame, in seconds. */
const MAX_AMBIENT_STEP = 0.1;

/** The browser's frame scheduler, motion preference, pixel ratio and canvases. */
export function browserEnvironment(): OrreryEnvironment {
  return {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    prefersReducedMotion: () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    devicePixelRatio: () => window.devicePixelRatio || 1,
    createSurface: (width, height): SpriteSurface | null => {
      if (typeof document === "undefined") return null;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      return context === null ? null : { image: canvas, context };
    },
  };
}

function finitePositive(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`);
  }
  return value;
}

const EMPTY_SCENE_SHAPE = { agents: [], totalTools: 0 } as const;

/** `createOrrery` with an explicit environment, for tests and hosts with their own scheduler. */
export function createOrreryWithEnvironment(
  canvas: HTMLCanvasElement,
  options: OrreryOptions = {},
  env: OrreryEnvironment,
): OrreryHandle {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the canvas has no 2D context");
  const ctx: DrawContext = context;

  const reducedMotion = options.reducedMotion ?? env.prefersReducedMotion();
  const minVisibleCallSeconds =
    options.minVisibleCallSeconds === undefined
      ? DEFAULT_MIN_VISIBLE_CALL_SECONDS
      : Number.isFinite(options.minVisibleCallSeconds) && options.minVisibleCallSeconds >= 0
        ? options.minVisibleCallSeconds
        : DEFAULT_MIN_VISIBLE_CALL_SECONDS;
  const dpr = finitePositive(
    options.devicePixelRatio ?? env.devicePixelRatio(),
    "devicePixelRatio",
  );
  const resources = createResources(env, createPalette(resolveTheme(options.theme)));

  let scene: Scene | null = null;
  let layout: Layout = createLayout(0, 0);
  let frame: FrameState = createFrameState(EMPTY_SCENE_SHAPE);
  let width = Math.max(0, canvas.clientWidth || canvas.width / dpr || 0);
  let height = Math.max(0, canvas.clientHeight || canvas.height / dpr || 0);
  let time = 0;
  let playing = false;
  let selectedId: ReplayAgentId | null = null;
  let hoveredId: ReplayAgentId | null = null;
  let ambient = 0;
  let lastNow = -1;
  let pending = false;
  let handle = 0;
  let destroyed = false;
  const timing = { speed: 1, minVisibleCallSeconds, reducedMotion };
  const view: ViewState = { selected: -1, hovered: -1, ambient: 0, dpr };
  const listeners: { [E in OrreryEventName]: Set<OrreryListener<E>> } = {
    select: new Set(),
    hover: new Set(),
  };

  const emit = <E extends OrreryEventName>(event: E, payload: OrreryEvents[E]): void => {
    for (const listener of listeners[event]) (listener as OrreryListener<E>)(payload);
  };
  const indexOf = (id: ReplayAgentId | null): number =>
    id === null || scene === null ? -1 : (scene.byId.get(id) ?? -1);
  const clampTime = (t: number): number => Math.max(0, Math.min(scene ? scene.duration : 0, t));

  const applySize = (): void => {
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    if (scene !== null) layout = computeLayout(scene, width, height, layout);
    else {
      layout.width = width;
      layout.height = height;
    }
  };

  const updateFrame = (): void => {
    if (scene !== null) computeFrameState(scene, time, timing, frame);
  };

  const render = (): void => {
    updateFrame();
    view.selected = indexOf(selectedId);
    view.hovered = indexOf(hoveredId);
    view.ambient = ambient;
    drawFrame(ctx, scene, layout, frame, view, resources);
  };

  const animating = (): boolean => playing && !reducedMotion;

  // Created once, so scheduling a frame allocates no closure.
  const onFrame = (now: number): void => {
    pending = false;
    if (destroyed) return;
    if (animating()) {
      if (lastNow >= 0) ambient += Math.min(MAX_AMBIENT_STEP, Math.max(0, (now - lastNow) / 1000));
      lastNow = now;
    } else {
      lastNow = -1;
    }
    render();
    if (animating()) schedule();
  };

  function schedule(): void {
    if (pending || destroyed) return;
    pending = true;
    handle = env.requestFrame(onFrame);
  }

  const pointerPosition = (event: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const hitAt = (event: MouseEvent): number => {
    if (scene === null) return -1;
    updateFrame();
    const { x, y } = pointerPosition(event);
    return hitTestAgents(layout, frame.phase, x, y);
  };
  const setHover = (id: ReplayAgentId | null): void => {
    if (id === hoveredId) return;
    hoveredId = id;
    if (canvas.style) canvas.style.cursor = id === null ? "" : "pointer";
    emit("hover", { agentId: id });
    schedule();
  };
  const onPointerMove = (event: PointerEvent): void => {
    const index = hitAt(event);
    setHover(index >= 0 && scene !== null ? scene.agents[index]!.id : null);
  };
  const onPointerLeave = (): void => setHover(null);
  const onClick = (event: MouseEvent): void => {
    if (scene === null) return;
    const index = hitAt(event);
    emit("select", { agentId: index >= 0 ? scene.agents[index]!.id : null });
  };
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("click", onClick);

  const loadScene = (next: Scene): void => {
    scene = next;
    layout = computeLayout(next, width, height, layout);
    if (!frameFits(frame, next)) frame = createFrameState(next);
    time = clampTime(time);
  };

  applySize();
  schedule();

  const handleApi: OrreryHandle = {
    setModel(model: ReplayModel): void {
      if (destroyed) return;
      const next = buildScene(model);
      selectedId = null;
      if (hoveredId !== null) {
        hoveredId = null;
        if (canvas.style) canvas.style.cursor = "";
      }
      loadScene(next);
      schedule();
    },
    updateModel(model: ReplayModel): void {
      if (destroyed) return;
      const next = buildScene(model);
      if (selectedId !== null && !next.byId.has(selectedId)) selectedId = null;
      if (hoveredId !== null && !next.byId.has(hoveredId)) hoveredId = null;
      loadScene(next);
      schedule();
    },
    setTime(t: number): void {
      if (destroyed || typeof t !== "number" || Number.isNaN(t)) return;
      time = clampTime(t);
      schedule();
    },
    play(): void {
      if (destroyed) return;
      playing = true;
      lastNow = -1;
      schedule();
    },
    pause(): void {
      if (destroyed) return;
      playing = false;
      schedule();
    },
    setSpeed(multiplier: number): void {
      if (destroyed) return;
      timing.speed = finitePositive(multiplier, "speed");
      schedule();
    },
    select(agentId: ReplayAgentId | null): void {
      if (destroyed) return;
      selectedId = agentId !== null && scene !== null && scene.byId.has(agentId) ? agentId : null;
      schedule();
    },
    on<E extends OrreryEventName>(event: E, listener: OrreryListener<E>): () => void {
      const set = listeners[event] as Set<OrreryListener<E>> | undefined;
      if (destroyed || set === undefined) return () => {};
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    resize(nextWidth: number, nextHeight: number): void {
      if (destroyed) return;
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight)) return;
      width = Math.max(0, nextWidth);
      height = Math.max(0, nextHeight);
      applySize();
      // Resizing clears the backing store; draw now so there is no blank frame.
      render();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (pending) env.cancelFrame(handle);
      pending = false;
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("click", onClick);
      listeners.select.clear();
      listeners.hover.clear();
      scene = null;
    },
  };
  return handleApi;
}

/** Create a renderer on a canvas, using the browser's environment. */
export const createOrrery: CreateOrrery = (canvas, options) =>
  createOrreryWithEnvironment(canvas, options, browserEnvironment());
