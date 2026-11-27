/**
 * The host's sessions, newest first, with the one shown marked, so the user can switch. Only
 * path-free `SessionSummary` fields are shown. Hidden in demo mode (the parent does not render it).
 *
 * A disclosure: a button with `aria-expanded` that shows and hides the list. It is a plain
 * button rather than `<details>` so it behaves the same in every browser, in an editor webview
 * and in tests. Escape closes the open list, and choosing a session closes it; both put focus
 * back on the button so focus is not lost inside the closed list.
 */

import { useId, useRef, useState } from "react";
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

/**
 * A comma only screen readers get, between parts of a button's name that sit side by side on
 * screen, so `example-project` and `5 min ago` are not read as one word.
 */
function Separator() {
  return <span className="visually-hidden">, </span>;
}

export function SessionPicker({ sessions, currentKey, onSelect, now }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const at = now ?? Date.now();
  const close = (): void => {
    setOpen(false);
    toggleRef.current?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    // Handled here, so the page shortcut (clear the selection) does not run as well.
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return (
    <div
      className={open ? "session-picker session-picker-open" : "session-picker"}
      onKeyDown={onKeyDown}
    >
      <button
        ref={toggleRef}
        type="button"
        className="session-toggle"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Sessions ({sessions.length})
      </button>
      {open ? (
        <ul className="session-list" id={listId} aria-label="Sessions">
          {sessions.map((session) => {
            const current = session.key === currentKey;
            return (
              <li key={session.key}>
                <button
                  type="button"
                  className="session-item"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    close();
                    onSelect(session.key);
                  }}
                >
                  <span className="session-label">{session.projectLabel}</span>
                  <Separator />
                  <span className="muted">
                    {formatAgo(session.lastActivity, at)}
                    {session.subagentCount !== null
                      ? `, ${plural(session.subagentCount, "subagent")}`
                      : ""}
                  </span>
                  {isLiveStatus(session.live) ? (
                    <>
                      <Separator />
                      <span className="badge badge-live">Live</span>
                    </>
                  ) : null}
                  {current ? (
                    <>
                      <Separator />
                      <span className="session-current">Shown</span>
                    </>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
