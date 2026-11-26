/**
 * Public API of @orbitrace/renderer, as types. Not implemented yet (ticket #10).
 *
 * The renderer draws one ReplayModel on a canvas. It does not own the replay clock: the host
 * (the app's timeline, a test, an export step) calls `setTime` whenever the time changes,
 * every frame during playback. `play`, `pause` and `setSpeed` only tell the renderer the
 * playback state, so it can run motion that is not tied to replay time (pulses, comets,
 * the minimum visible time of short calls, the warp effect) and stop it when paused.
 * The renderer never advances replay time on its own.
 *
 * The renderer has no framework dependency and reads nothing but the model it is given.
 */

import type { ReplayAgentId, ReplayModel, ReplaySeconds } from "@orbitrace/core";

/**
 * Colours the renderer uses. Defaults come from the prototype's CSS `:root` block.
 * A tool call's colour comes from its `kind` (`ToolKind` in core), never from its `name`.
 */
export interface OrreryTheme {
  readonly background: string;
  readonly text: string;
  /** Calls of kind `shell`. */
  readonly shell: string;
  /** Calls of kind `read`, `mcp` and `other`. */
  readonly read: string;
  /** Calls of kind `edit`. */
  readonly edit: string;
  /** Calls of kind `agent`, dispatch comets. */
  readonly agent: string;
  /** Handback comets. */
  readonly handback: string;
  /** Failed calls. */
  readonly failure: string;
}

export interface OrreryOptions {
  /**
   * Reduced motion: no ambient animation, a still frame for each `setTime`. Default: the
   * user's `prefers-reduced-motion` setting. The host must also skip autoplay.
   */
  readonly reducedMotion?: boolean;
  /** Minimum time, in real seconds, that a call stays visible as a spoke. */
  readonly minVisibleCallSeconds?: number;
  /** Device pixel ratio for the backing store. Default `window.devicePixelRatio`. */
  readonly devicePixelRatio?: number;
  readonly theme?: Partial<OrreryTheme>;
}

/** Events the renderer emits, with their payloads. */
export interface OrreryEvents {
  /** The user clicked an agent, or empty space (`null`). The host decides whether to call `select`. */
  readonly select: { readonly agentId: ReplayAgentId | null };
  /** The pointer moved onto an agent, or off all agents (`null`). */
  readonly hover: { readonly agentId: ReplayAgentId | null };
}

export type OrreryEventName = keyof OrreryEvents;

export type OrreryListener<E extends OrreryEventName> = (payload: OrreryEvents[E]) => void;

export interface OrreryHandle {
  /**
   * Load a different replay (another session, or a dropped file). Clears the selection and
   * all per-agent transient state (pulses, comets, warp effect). The current time is clamped
   * to the new model's `totals.duration`.
   */
  setModel(model: ReplayModel): void;
  /**
   * Replace the model with a newer snapshot of the same session (live view). Relies on the
   * append-stability rules in core's `model/replay.ts`: agent ids are stable across snapshots.
   * - Keeps the selection when the selected id exists in the new model; otherwise clears it
   *   without emitting `select`.
   * - Keeps per-agent transient state keyed by agent id, for ids that still exist; new agents
   *   start with none.
   * - Keeps the current time, clamped to the new model's `totals.duration`.
   * Does not change the playback state set by `play`, `pause` and `setSpeed`.
   */
  updateModel(model: ReplayModel): void;
  /** Draw the state at time `t` on the compressed timeline. */
  setTime(t: ReplaySeconds): void;
  /** The host's clock is running. Starts motion that is not tied to replay time. */
  play(): void;
  /** The host's clock stopped. Freezes that motion. */
  pause(): void;
  /** Playback rate of the host's clock, for example 1, 2 or 8. Must be greater than 0. */
  setSpeed(multiplier: number): void;
  /** Highlight one agent, or clear the selection with `null`. */
  select(agentId: ReplayAgentId | null): void;
  /** Subscribe to an event. Returns a function that removes the listener. */
  on<E extends OrreryEventName>(event: E, listener: OrreryListener<E>): () => void;
  /** The canvas changed size, in CSS pixels. */
  resize(width: number, height: number): void;
  /** Stop all animation, remove listeners, release the canvas. The handle is unusable afterwards. */
  destroy(): void;
}

/** Create a renderer on a canvas. Ticket #10 exports `createOrrery` with this type. */
export type CreateOrrery = (canvas: HTMLCanvasElement, options?: OrreryOptions) => OrreryHandle;
