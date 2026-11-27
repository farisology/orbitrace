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
 *
 * The lanes scroll inside the dock (issue 144), which has a fixed share of the height, so new
 * lanes never shrink the orrery. While following, a newly added lane is scrolled into view unless
 * the user has scrolled the lanes away from their end, or it would hide the selected or focused
 * lane; a new selection scrolls its lane into view (`lane-scroll.ts`). Only the lane list scrolls,
 * never the page.
 *
 * The playhead stays inside the tracks at every time (issue 172): at the live edge a line drawn
 * from `left: 100%` would reach past the lanes by its own width and bring up a horizontal
 * scrollbar that came and went while following (`playheadLeft`).
 */

import { memo, useCallback, useId, useLayoutEffect, useRef } from "react";
import {
  toRealSeconds,
  type ReplayAgent,
  type ReplayAgentId,
  type ReplayModel,
} from "@orbitrace/core";
import type { ClockState } from "../clock";
import { familyShape } from "../agent-stats";
import { formatClock, formatDuration, plural } from "../format";
import {
  isInView,
  newLaneScrollTop,
  revealScrollTop,
  type LaneSpan,
  type ScrollView,
} from "../lane-scroll";
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

/** Width of the playhead line in CSS pixels: its `border-left` in app.css. */
export const PLAYHEAD_WIDTH_PX = 2;

/**
 * CSS `left` of the playhead at `fraction` (0 to 1) of the timeline: the share of the track minus
 * the same share of the line's width, so the line starts at the left edge at 0 and ends at the
 * right edge at 1, never past it (issue 172).
 */
export function playheadLeft(fraction: number): string {
  const share = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  if (share === 0) return "0%";
  return `calc(${share * 100}% - ${share * PLAYHEAD_WIDTH_PX}px)`;
}

function Playhead() {
  const fraction = useClockValue(selectFraction);
  return <div className="playhead" style={{ left: playheadLeft(fraction) }} aria-hidden="true" />;
}

export interface TimelineProps {
  readonly model: ReplayModel;
  readonly selected: ReplayAgentId | null;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
  /**
   * Changes when a different replay is shown (not for a newer snapshot of the same one): the
   * lanes then start at the top, and nothing counts as newly added. Default 0.
   */
  readonly generation?: number;
}

/** The extent of a lane element in the scrolling body (its offset parent). */
function spanOf(lane: Element | null | undefined): LaneSpan | null {
  if (!(lane instanceof HTMLElement)) return null;
  return { top: lane.offsetTop, bottom: lane.offsetTop + lane.offsetHeight };
}

function viewOf(body: HTMLElement): ScrollView {
  return { scrollTop: body.scrollTop, height: body.clientHeight };
}

/** Scroll the lane list, and note where, so the scroll event it causes is not the user's. */
function scrollLanesTo(body: HTMLElement, top: number, own: { current: number | null }): void {
  body.scrollTop = top;
  // Read back: the browser clamps to the scroll range.
  own.current = body.scrollTop;
}

export function Timeline({ model, selected, onSelect, generation = 0 }: TimelineProps) {
  const clock = useClock();
  const tracksRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLOListElement>(null);
  /** The agents shown last, to tell which lanes a newer snapshot added. */
  const knownRef = useRef<{ readonly generation: number; readonly ids: Set<string> } | null>(null);
  /** The user scrolled the lanes away from their end: new lanes no longer scroll into view. */
  const userScrolledRef = useRef(false);
  /** The position this component last scrolled to, so its own scroll is not taken as the user's. */
  const autoTopRef = useRef<number | null>(null);
  const headingId = useId();
  const duration = model.totals.duration;

  // Runs before the effects below, so they read the props of this render.
  const latest = useRef({ agents: model.agents, selected });
  useLayoutEffect(() => {
    latest.current = { agents: model.agents, selected };
  });

  // A newer snapshot added lanes: show the newest while following (see the header). Runs only
  // when the agents or the replay change; a change of selection is the next effect's.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const lanes = lanesRef.current;
    const ids = model.agents.map((agent) => agent.id);
    const known = knownRef.current;
    knownRef.current = { generation, ids: new Set(ids) };
    if (body === null || lanes === null || known === null) return;
    if (known.generation !== generation) {
      userScrolledRef.current = false;
      scrollLanesTo(body, 0, autoTopRef);
      return;
    }
    let newest = -1;
    ids.forEach((id, index) => {
      if (!known.ids.has(id)) newest = index;
    });
    if (newest < 0 || userScrolledRef.current || !clock.getState().following) return;
    const added = spanOf(lanes.children[newest]);
    if (added === null) return;
    const keep: LaneSpan[] = [];
    const current = latest.current.selected;
    const selectedSpan = current === null ? null : spanOf(lanes.children[ids.indexOf(current)]);
    if (selectedSpan !== null) keep.push(selectedSpan);
    const focused = document.activeElement;
    if (focused !== null && lanes.contains(focused)) {
      const focusedSpan = spanOf(focused.closest(".lane"));
      if (focusedSpan !== null) keep.push(focusedSpan);
    }
    const next = newLaneScrollTop(viewOf(body), added, keep);
    if (next !== null) scrollLanesTo(body, next, autoTopRef);
  }, [clock, model.agents, generation]);

  // A new selection (from the orrery, the inspector or the event feed) brings its lane into view.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const lanes = lanesRef.current;
    if (body === null || lanes === null || selected === null) return;
    const index = latest.current.agents.findIndex((agent) => agent.id === selected);
    const span = index < 0 ? null : spanOf(lanes.children[index]);
    if (span === null) return;
    const next = revealScrollTop(viewOf(body), span);
    if (next !== null) scrollLanesTo(body, next, autoTopRef);
  }, [selected]);

  const onBodyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const body = event.currentTarget;
    const own = autoTopRef.current;
    autoTopRef.current = null;
    if (own !== null && Math.abs(body.scrollTop - own) < 1) return;
    // Away from the end (the last lane not wholly visible) stops new lanes from scrolling into
    // view; back at the end, they do again.
    const last = spanOf(lanesRef.current?.lastElementChild);
    userScrolledRef.current = last !== null && !isInView(viewOf(body), last);
  };

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
      <div className="timeline-body" ref={bodyRef} onScroll={onBodyScroll}>
        <ol className="lanes" aria-label="Agents" onKeyDown={onLanesKeyDown} ref={lanesRef}>
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
