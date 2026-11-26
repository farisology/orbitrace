/**
 * The host's sessions, newest first, with the one shown marked, so the user can switch. Only
 * path-free `SessionSummary` fields are shown. Hidden in demo mode (the parent does not render it).
 */

import { useRef } from "react";
import type { LiveStatus, SessionSummary } from "@orbitrace/core";
import { formatAgo, plural } from "../format";

export interface SessionPickerProps {
  readonly sessions: readonly SessionSummary[];
  /** Key of the session shown, if any. */
  readonly currentKey: string | undefined;
  readonly onSelect: (key: string) => void;
  /** Unix epoch milliseconds for "how long ago". Default: now. */
  readonly now?: number;
}

/** Whether a session's process is running. */
export function isLiveStatus(live: LiveStatus): boolean {
  return live === "busy" || live === "idle";
}

export function SessionPicker({ sessions, currentKey, onSelect, now }: SessionPickerProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const at = now ?? Date.now();
  return (
    <details className="session-picker" ref={detailsRef}>
      <summary>Sessions ({sessions.length})</summary>
      <ul className="session-list" aria-label="Sessions">
        {sessions.map((session) => {
          const current = session.key === currentKey;
          return (
            <li key={session.key}>
              <button
                type="button"
                className="session-item"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  if (detailsRef.current !== null) detailsRef.current.open = false;
                  onSelect(session.key);
                }}
              >
                <span className="session-label">{session.projectLabel}</span>
                <span className="muted">
                  {formatAgo(session.lastActivity, at)}
                  {session.subagentCount !== null
                    ? `, ${plural(session.subagentCount, "subagent")}`
                    : ""}
                </span>
                {isLiveStatus(session.live) ? <span className="badge badge-live">Live</span> : null}
                {current ? <span className="session-current">Shown</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
