/**
 * One lane per agent on the compressed timeline: its lifetime, its tool calls coloured by kind
 * (failed calls in the failure colour), a marker for each idle skip and the playhead. Pressing
 * or dragging on the lanes scrubs; a lane's label selects its agent.
 */

import { memo, useCallback, useRef } from "react";
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

/** Shortest drawn width of a call, as a share of the timeline, so sub-second calls show. */
export const MIN_CALL_SHARE = 0.002;

/** Horizontal position of time `t` as a percentage of the timeline. */
export function percentAt(t: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(100, Math.max(0, (t / duration) * 100));
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
          <span className="lane-fail" aria-label={`${failed} failed`}>
            {failed}
          </span>
        ) : null}
      </button>
      <svg
        className="lane-track"
        viewBox={`0 0 ${Math.max(duration, 1e-6)} 10`}
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
          const kindClass = tool.failed ? "call call-failed" : `call k-${tool.kind}`;
          return (
            <rect
              key={index}
              className={kindClass}
              x={tool.start}
              y={tool.failed ? 0.5 : 2}
              width={Math.max(minWidth, toolEnd - tool.start)}
              height={tool.failed ? 9 : 6}
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
  const duration = model.totals.duration;

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
    <section className="timeline" aria-label="Timeline">
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
              aria-label={`Idle skip at ${formatClock(toRealSeconds(model.warps, warp.at))}: ${formatDuration(
                warp.skipped,
              )} cut. Jump here.`}
              title={`Idle skip: ${formatDuration(warp.skipped)} cut`}
            >
              <span aria-hidden="true">skip {formatDuration(warp.skipped)}</span>
            </button>
          ))}
          <span className="ruler-end">{formatClock(model.totals.realDuration)}</span>
        </div>
      </div>
      <div className="timeline-body">
        <ol className="lanes" aria-label="Agents">
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
