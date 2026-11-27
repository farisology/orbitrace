/**
 * Play and pause, Go live (while the session runs), speed, the scrubber and the clock readout.
 *
 * Go live (issue 127) is shown while the clock is live. While the view follows the live edge it stays
 * in place, keeps its name and is marked `aria-disabled`, so focus on it is never lost and its
 * name never changes under a speech input user; the Live badge says "following". When the session
 * ends the button goes away; if it had focus, focus moves to the play button.
 */

import { useCallback, useId, useLayoutEffect, useRef } from "react";
import { toRealSeconds, type ReplayModel } from "@orbitrace/core";
import { PLAYBACK_RATES, type ClockState } from "../clock";
import { formatClock } from "../format";
import { useClock, useClockValue } from "../use-clock";

const selectPlaying = (state: ClockState): boolean => state.playing;
const selectRate = (state: ClockState): number => state.rate;
const selectTime = (state: ClockState): number => state.time;
const selectLive = (state: ClockState): boolean => state.live;
const selectFollowing = (state: ClockState): boolean => state.following;

export const GO_LIVE_LABEL = "Go live";

interface GoLiveProps {
  readonly following: boolean;
  readonly onGoLive: () => void;
  /** Called when the button goes away while it has focus. */
  readonly onRemovedWithFocus: () => void;
}

function GoLiveButton({ following, onGoLive, onRemovedWithFocus }: GoLiveProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  const removed = useRef(onRemovedWithFocus);
  useLayoutEffect(() => {
    removed.current = onRemovedWithFocus;
  });
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      const active = document.activeElement;
      const focusLost = active === null || active === document.body;
      if (active === node || (hadFocus.current && focusLost)) removed.current();
    };
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      className="control-live"
      aria-disabled={following}
      aria-keyshortcuts="End"
      title={following ? "Following the live edge" : "Jump to the live edge and follow it"}
      onFocus={() => {
        hadFocus.current = true;
      }}
      onBlur={() => {
        hadFocus.current = false;
      }}
      onClick={() => {
        if (!following) onGoLive();
      }}
    >
      {GO_LIVE_LABEL}
    </button>
  );
}

/** `4:12 of 17:47`: real time at `t` and the real length of the session. */
export function positionText(model: ReplayModel, t: number): string {
  return `${formatClock(toRealSeconds(model.warps, t))} of ${formatClock(model.totals.realDuration)}`;
}

/**
 * Value text of the scrubber for screen readers. Paused: the exact position. Playing: the
 * position rounded down to the minute, so a screen reader that reads a focused slider's value
 * changes speaks at most once per replay minute instead of on every frame. Following the live
 * edge: the same, without the length, which grows with every snapshot.
 */
export function scrubValueText(
  model: ReplayModel,
  t: number,
  playing: boolean,
  following = false,
): string {
  if (!playing) return `${positionText(model, t)}, real time`;
  const minute = Math.floor(toRealSeconds(model.warps, t) / 60) * 60;
  if (following) return `Following live, past ${formatClock(minute)}, real time`;
  return `Playing, past ${formatClock(minute)} of ${formatClock(model.totals.realDuration)}, real time`;
}

export interface ControlsProps {
  readonly model: ReplayModel;
  /** Id of the play button, so the skip link can move focus to it. */
  readonly playButtonId?: string;
}

export function Controls({ model, playButtonId }: ControlsProps) {
  const clock = useClock();
  const playing = useClockValue(selectPlaying);
  const rate = useClockValue(selectRate);
  const time = useClockValue(selectTime);
  const live = useClockValue(selectLive);
  const following = useClockValue(selectFollowing);
  const speedId = useId();
  const playRef = useRef<HTMLButtonElement>(null);
  const duration = model.totals.duration;

  const onScrub = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => clock.seek(Number(event.target.value)),
    [clock],
  );

  return (
    <div className="controls" role="group" aria-label="Playback">
      <button
        ref={playRef}
        type="button"
        id={playButtonId}
        className="control-play"
        onClick={() => clock.toggle()}
        aria-keyshortcuts="Space"
      >
        <span aria-hidden="true" className="control-icon">
          {playing ? "❚❚" : "▶"}
        </span>
        {playing ? "Pause" : "Play"}
      </button>
      {live ? (
        <GoLiveButton
          following={following}
          onGoLive={() => clock.follow()}
          onRemovedWithFocus={() => playRef.current?.focus()}
        />
      ) : null}
      <label className="control-speed" htmlFor={speedId}>
        Speed
        <select
          id={speedId}
          value={rate}
          onChange={(event) => clock.setRate(Number(event.target.value))}
        >
          {PLAYBACK_RATES.map((option) => (
            <option key={option} value={option}>
              {option}
              {"×"}
            </option>
          ))}
        </select>
      </label>
      <input
        className="control-scrub"
        type="range"
        min={0}
        max={duration}
        step="any"
        value={time}
        onChange={onScrub}
        aria-label="Replay position"
        aria-valuetext={scrubValueText(model, time, playing, following)}
        aria-keyshortcuts="ArrowLeft ArrowRight"
      />
      <output className="control-clock" aria-live="off" title="Real time, idle gaps included">
        {positionText(model, time)}
      </output>
    </div>
  );
}
