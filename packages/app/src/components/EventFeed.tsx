/**
 * Events up to the current time, newest first: dispatches, handbacks, idle skips, and failed
 * calls grouped by `replayFeed` from @orbitrace/core. Choosing an event jumps to it. Before the
 * first event the feed says so, and asks the user to press play only while the replay is paused
 * (issue 159).
 */

import { useCallback, useMemo } from "react";
import { replayFeed, toRealSeconds, type ReplayAgentId, type ReplayModel } from "@orbitrace/core";
import { callsigns } from "../agent-stats";
import { countAtOrBefore, type ClockState } from "../clock";
import { describeFeedEvent } from "../feed-text";
import { formatClock } from "../format";
import { useClock, useClockValue } from "../use-clock";

const TAG_LABELS = {
  dispatch: "Dispatch",
  handback: "Handback",
  failures: "Failed",
  idle: "Idle",
} as const;

export interface EventFeedProps {
  readonly model: ReplayModel;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
}

/** What the feed says when it lists no event. */
export const EMPTY_FEED_TEXT = {
  noEvents: "This replay has no events.",
  notYet: "No events yet.",
  notYetPaused: "No events yet. Press play.",
} as const;

/**
 * The empty feed's text, from the number of events in the replay (`total`), whether it is
 * playing or following (`playing`) and whether the session still runs (`live`).
 *
 * - No events at all: "This replay has no events.", or "No events yet." while the session runs,
 *   since a running session can still add some.
 * - Events, none reached yet: "Press play." only while paused; playing or following, it would
 *   ask for what is already happening.
 */
export function emptyFeedText(total: number, playing: boolean, live = false): string {
  if (total === 0) return live ? EMPTY_FEED_TEXT.notYet : EMPTY_FEED_TEXT.noEvents;
  return playing ? EMPTY_FEED_TEXT.notYet : EMPTY_FEED_TEXT.notYetPaused;
}

/** Playing, or following the live edge (which holds there and still counts as playing). */
const selectRunning = (state: ClockState): boolean => state.playing || state.following;
const selectLive = (state: ClockState): boolean => state.live;

export function EventFeed({ model, onSelect }: EventFeedProps) {
  const clock = useClock();
  const events = useMemo(() => replayFeed(model), [model]);
  const names = useMemo(() => callsigns(model), [model]);
  const selectCount = useCallback(
    (state: ClockState) => countAtOrBefore(events, state.time),
    [events],
  );
  const shown = useClockValue(selectCount);
  const running = useClockValue(selectRunning);
  const live = useClockValue(selectLive);
  const visible = useMemo(
    () =>
      events
        .slice(0, shown)
        .map((event, index) => ({ event, index }))
        .reverse(),
    [events, shown],
  );

  return (
    <section className="panel feed" aria-labelledby="feed-title">
      <div className="panel-head">
        <h2 id="feed-title">Events</h2>
        <span className="muted">
          {shown} of {events.length}
        </span>
      </div>
      {visible.length === 0 ? (
        <p className="muted">{emptyFeedText(events.length, running, live)}</p>
      ) : (
        <ol className="feed-list">
          {visible.map(({ event, index }) => {
            const line = describeFeedEvent(event, names);
            return (
              <li key={index}>
                <button
                  type="button"
                  className={`feed-item tag-${line.tag}`}
                  onClick={() => {
                    clock.seek(event.t);
                    if (line.agent !== null) onSelect(line.agent);
                  }}
                >
                  <time className="feed-time">
                    {formatClock(toRealSeconds(model.warps, event.t))}
                  </time>
                  {/* Screen reader commas: the grid cells would otherwise run together. */}
                  <span className="feed-tag">
                    <span className="visually-hidden">, </span>
                    {TAG_LABELS[line.tag]}
                    <span className="visually-hidden">: </span>
                  </span>
                  <span className="feed-text">{line.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
