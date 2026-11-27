/** Play and pause, speed, the scrubber and the clock readout. */

import { useCallback, useId } from "react";
import { toRealSeconds, type ReplayModel } from "@orbitrace/core";
import { PLAYBACK_RATES, type ClockState } from "../clock";
import { formatClock } from "../format";
import { useClock, useClockValue } from "../use-clock";

const selectPlaying = (state: ClockState): boolean => state.playing;
const selectRate = (state: ClockState): number => state.rate;
const selectTime = (state: ClockState): number => state.time;

/** `4:12 of 17:47`: real time at `t` and the real length of the session. */
export function positionText(model: ReplayModel, t: number): string {
  return `${formatClock(toRealSeconds(model.warps, t))} of ${formatClock(model.totals.realDuration)}`;
}

/**
 * Value text of the scrubber for screen readers. Paused: the exact position. Playing: the
 * position rounded down to the minute, so a screen reader that reads a focused slider's value
 * changes speaks at most once per replay minute instead of on every frame.
 */
export function scrubValueText(model: ReplayModel, t: number, playing: boolean): string {
  if (!playing) return `${positionText(model, t)}, real time`;
  const minute = Math.floor(toRealSeconds(model.warps, t) / 60) * 60;
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
  const speedId = useId();
  const duration = model.totals.duration;

  const onScrub = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => clock.seek(Number(event.target.value)),
    [clock],
  );

  return (
    <div className="controls" role="group" aria-label="Playback">
      <button
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
        aria-valuetext={scrubValueText(model, time, playing)}
        aria-keyshortcuts="ArrowLeft ArrowRight"
      />
      <output className="control-clock" aria-live="off" title="Real time, idle gaps included">
        {positionText(model, time)}
      </output>
    </div>
  );
}
