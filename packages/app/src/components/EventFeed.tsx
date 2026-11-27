/**
 * Events up to the current time, newest first: dispatches, handbacks, idle skips, and failed
 * calls grouped by `replayFeed` from @orbitrace/core. Choosing an event jumps to it.
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

export function EventFeed({ model, onSelect }: EventFeedProps) {
  const clock = useClock();
  const events = useMemo(() => replayFeed(model), [model]);
  const names = useMemo(() => callsigns(model), [model]);
  const selectCount = useCallback(
    (state: ClockState) => countAtOrBefore(events, state.time),
    [events],
  );
  const shown = useClockValue(selectCount);
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
        <p className="muted">
          {events.length === 0 ? "This replay has no events." : "No events yet. Press play."}
        </p>
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
