/**
 * One lane per agent on the compressed timeline: its lifetime, its tool calls, a marker for each
 * idle skip and the playhead. Each kind of call has its own colour and its own height and
 * position in the lane, and failed calls fill the lane in the failure colour, so colour is not
 * the only sign (`CallMark.tsx`); a legend above the lanes names each mark. Pressing or dragging
 * on the lanes scrubs; a lane's label selects its agent.
 *
 * Keyboard: Tab reaches every lane label, and Up and Down move between them. Scrubbing by
 * keyboard is the Replay position slider in the controls, or Left and Right anywhere on the page
 * (also with a lane label focused). The drawn tracks are hidden from screen readers; the table of
 * agents after the orrery and the inspector say the same in words. Lane names wrap rather than
 * being cut off, so the `#1` / `#2` suffix that tells two lanes apart stays visible at any zoom.
 */

import { memo, useCallback, useId, useRef } from "react";
import {
  toRealSeconds,
  type ReplayAgent,
  type ReplayAgentId,
  type ReplayModel,
} from "@orbitrace/core";
import type { ClockState } from "../clock";
import { familyShape } from "../agent-stats";
import { formatClock, formatDuration, plural } from "../format";
import { useClock, useClockValue } from "../use-clock";
import { CALL_LEGEND, CALL_TRACK_UNITS, CallMark, callBand, callClass } from "./CallMark";

/** Shortest drawn width of a call, as a share of the timeline, so sub-second calls show. */
export const MIN_CALL_SHARE = 0.002;

/** Horizontal position of time `t` as a percentage of the timeline. */
export function percentAt(t: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(100, Math.max(0, (t / duration) * 100));
}

/**
 * Index of the lane label to focus after `key` on the label at `current`, or `null` when the key
 * does not move between lanes. Up and Down stop at the first and last lane.
 */
export function laneFocusIndex(current: number, count: number, key: string): number | null {
  if (count <= 0 || current < 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, current + 1);
  if (key === "ArrowUp") return Math.max(0, current - 1);
  return null;
}

/** Time under a pointer at `clientX` on a track spanning `left` to `left + width`. */
export function timeAtPointer(
  clientX: number,
  left: number,
  width: number,
  duration: number,
): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  return Math.min(duration, Math.max(0, ((clientX - left) / width) * duration));
}

interface LaneProps {
  readonly agent: ReplayAgent;
  readonly duration: number;
  readonly selected: boolean;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
}

const Lane = memo(function Lane({ agent, duration, selected, onSelect }: LaneProps) {
  const end = agent.end ?? duration;
  const minWidth = duration * MIN_CALL_SHARE;
  const failed = agent.totals.failedToolCalls;
  return (
    <li className={selected ? "lane lane-selected" : "lane"}>
      <button
        type="button"
        className="lane-label"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : agent.id)}
        title={`${agent.callsign}: ${familyShape(agent.family)}, ${plural(agent.tools.length, "tool call")}${
          failed > 0 ? `, ${failed} failed` : ""
        }`}
      >
        <span className="lane-name">{agent.callsign}</span>
        {failed > 0 ? (
          <span className="lane-fail">
            <span aria-hidden="true">
              {"✕"}
              {failed}
            </span>
            <span className="visually-hidden">, {failed} failed</span>
          </span>
        ) : null}
      </button>
      <svg
        className="lane-track"
        viewBox={`0 0 ${Math.max(duration, 1e-6)} ${CALL_TRACK_UNITS}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          className="lane-life"
          x={agent.start}
          y={3.5}
          width={Math.max(0, end - agent.start)}
          height={3}
        />
        {agent.tools.map((tool, index) => {
          const toolEnd = tool.end ?? duration;
          const band = callBand(tool.kind, tool.failed);
          return (
            <rect
              key={index}
              className={callClass(tool.kind, tool.failed)}
              x={tool.start}
              y={band.y}
              width={Math.max(minWidth, toolEnd - tool.start)}
              height={band.height}
            />
          );
        })}
      </svg>
    </li>
  );
});

const selectFraction = (state: ClockState): number =>
  state.duration > 0 ? state.time / state.duration : 0;

function Playhead() {
  const fraction = useClockValue(selectFraction);
  return <div className="playhead" style={{ left: `${fraction * 100}%` }} aria-hidden="true" />;
}

export interface TimelineProps {
  readonly model: ReplayModel;
  readonly selected: ReplayAgentId | null;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
}

export function Timeline({ model, selected, onSelect }: TimelineProps) {
  const clock = useClock();
  const tracksRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const duration = model.totals.duration;

  // Up and Down move focus between lane labels.
  const onLanesKeyDown = (event: React.KeyboardEvent<HTMLOListElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const labels = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".lane-label"),
    );
    const next = laneFocusIndex(
      labels.indexOf(event.target as HTMLButtonElement),
      labels.length,
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    labels[next]?.focus();
  };

  const seekAt = useCallback(
    (clientX: number) => {
      const box = tracksRef.current?.getBoundingClientRect();
      if (box === undefined) return;
      clock.seek(timeAtPointer(clientX, box.left, box.width, duration));
    },
    [clock, duration],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    seekAt(event.clientX);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) seekAt(event.clientX);
  };

  return (
    <section className="timeline" aria-labelledby={headingId}>
      <h2 className="visually-hidden" id={headingId}>
        Timeline
      </h2>
      <ul className="timeline-legend" aria-label="Tool call marks">
        {CALL_LEGEND.map((entry) => (
          <li key={entry.label}>
            <CallMark kind={entry.kind} failed={entry.failed} />
            {entry.label}
          </li>
        ))}
      </ul>
      <div className="timeline-ruler">
        <span className="ruler-start">0:00</span>
        <div className="ruler-marks">
          {model.warps.map((warp, index) => (
            <button
              key={index}
              type="button"
              className="warp-mark"
              style={{ left: `${percentAt(warp.at, duration)}%` }}
              onClick={() => clock.seek(warp.at)}
              title={`Idle skip: ${formatDuration(warp.skipped)} cut`}
            >
              skip {formatDuration(warp.skipped)}
              <span className="visually-hidden">
                : idle skip at {formatClock(toRealSeconds(model.warps, warp.at))}. Jump here.
              </span>
            </button>
          ))}
          <span className="ruler-end">{formatClock(model.totals.realDuration)}</span>
        </div>
      </div>
      <div className="timeline-body">
        <ol className="lanes" aria-label="Agents" onKeyDown={onLanesKeyDown}>
          {model.agents.map((agent) => (
            <Lane
              key={agent.id}
              agent={agent}
              duration={duration}
              selected={agent.id === selected}
              onSelect={onSelect}
            />
          ))}
        </ol>
        <div
          className="tracks-overlay"
          ref={tracksRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          aria-hidden="true"
        >
          {model.warps.map((warp, index) => (
            <div
              key={index}
              className="warp-line"
              style={{ left: `${percentAt(warp.at, duration)}%` }}
            />
          ))}
          <Playhead />
        </div>
      </div>
    </section>
  );
}
