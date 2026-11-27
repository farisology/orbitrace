/**
 * The Orbitrace app: the orrery, the inspector, the timeline, the controls and the event feed.
 *
 * It talks to its host only through `HostTransport`. A live session (or one whose status it does
 * not know) is followed with `subscribe`: the first update goes to `setModel`, later ones to
 * `updateModel`, so selection and time are kept. A session listed as ended is read once with
 * `loadReplay`. Errors the host reports are shown. With a session list (from `Root`), a picker
 * in the header switches sessions. A file dropped or picked by the user is read in the page with core
 * and never goes through the transport.
 *
 * Follow live (issue 127): a session whose first update says it is running (`busy` or `idle`) opens at
 * the live edge with follow on, unless the URL asked for a time or for `paused`. Each later
 * snapshot carries the playhead through real time onto the new timeline (`follow.ts`) and hands
 * it to the clock, which catches up to the new edge while following (`clock.ts`). The session
 * ending ends follow. The Live badge says whether the view follows or how far behind it is.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  LiveStatus,
  ReplayAgentId,
  ReplayModel,
  SessionSummary,
  Unsubscribe,
} from "@orbitrace/core";
import {
  FOLLOW_ANNOUNCEMENTS,
  LIVE_ANNOUNCE_INTERVAL_MS,
  followAnnouncement,
  liveStatusAnnouncement,
  loadedAnnouncement,
  newAgentsAnnouncement,
} from "./announce";
import { createClock, type Clock, type ClockState } from "./clock";
import {
  behindSeconds,
  followStartTime,
  followStatusText,
  isFollowable,
  remapTime,
} from "./follow";
import { Controls } from "./components/Controls";
import { EventFeed } from "./components/EventFeed";
import { CLEAR_SELECTION_CLASS, INSPECTOR_HEADING_ID, Inspector } from "./components/Inspector";
import { OrreryView } from "./components/OrreryView";
import { isLiveStatus, SessionPicker } from "./components/SessionPicker";
import { Timeline } from "./components/Timeline";
import { keyAction, targetHandlesKey } from "./keyboard";
import { loadFile, type DroppedKind, type FileLoadError } from "./load-file";
import { isTransportError, transportError } from "./no-host-transport";
import { usePrefersReducedMotion } from "./reduced-motion";
import type { HostTransport, TransportError } from "./transport";
import {
  ClockContext,
  useClockDriver,
  useClockValue,
  type FrameScheduler,
  browserFrames,
} from "./use-clock";
import { NO_START_OPTIONS, startSelection, type StartOptions } from "./url-state";

export type ReplaySource =
  | { readonly kind: "host"; readonly label: string; readonly live: LiveStatus }
  | { readonly kind: "file"; readonly fileKind: DroppedKind; readonly name: string };

interface View {
  readonly model: ReplayModel;
  /** Increases each time a different replay is loaded. */
  readonly generation: number;
  readonly source: ReplaySource;
}

type Stage = "loading" | "empty" | "error" | "ready";

export const APP_MESSAGES = {
  loading: "Loading the session…",
  empty: "No session to show.",
  dropHint: "Drop a .replay.json replay or a .jsonl transcript anywhere on this page, or open one.",
  hostFailed: "The session could not be loaded.",
  dropHere: "Drop to open. The file is read in this page and is not sent anywhere.",
  transcriptNote: "Main agent only: subagent transcripts are separate files.",
  notAffiliated: "Orbitrace is an independent project and is not affiliated with Anthropic.",
  skipToControls: "Skip to playback controls",
} as const;

/** Header text for where the replay came from. */
export function sourceLabel(source: ReplaySource): string {
  if (source.kind === "host") return source.label;
  return source.fileKind === "replay"
    ? `Replay file: ${source.name}`
    : `Transcript: ${source.name}`;
}

/** Badge text for a host session's live status, or `null` when there is nothing to say. */
export function liveLabel(live: LiveStatus): string | null {
  switch (live) {
    case "busy":
      return "Live: working";
    case "idle":
      return "Live: idle";
    case "ended":
      return "Replay";
    default:
      return null;
  }
}

/**
 * The Live badge of a host session: its live status, and while it runs whether the view follows
 * the live edge or how far behind it is in real time ("Live: working, following", "Live: idle,
 * 2 min 5 s behind"). Reads the clock itself, so only the badge re-renders when the text changes
 * (at most once a second while playing behind). Not a live region: it never announces on its own.
 */
function LiveBadge({ live, model }: { readonly live: LiveStatus; readonly model: ReplayModel }) {
  const followable = isFollowable(live);
  const selectFollow = useCallback(
    (state: ClockState) => followStatusText(state.following, behindSeconds(model, state.time)),
    [model],
  );
  const follow = useClockValue(selectFollow);
  const label = liveLabel(live);
  if (label === null) return null;
  return (
    <span className={followable ? "badge badge-live" : "badge"}>
      <span>
        {label}
        {followable ? <span className="badge-follow">, {follow}</span> : null}
      </span>
    </span>
  );
}

function asTransportError(error: unknown): TransportError {
  return isTransportError(error) ? error : transportError("internal", APP_MESSAGES.hostFailed);
}

export interface AppProps {
  readonly transport: HostTransport;
  /** Open this session. Default: the first session the host lists. */
  readonly sessionKey?: string;
  /**
   * The host's sessions. When given with `onSessionChange`, the header shows a session picker,
   * and the summary of `sessionKey` sets its label and whether it is followed live.
   */
  readonly sessions?: readonly SessionSummary[];
  /** Called with the key the user picked. The parent passes it back as `sessionKey`. */
  readonly onSessionChange?: (key: string) => void;
  /** A short note shown in the header, for example why the demo is shown. */
  readonly notice?: string | null;
  /** Applied to the first replay shown (from the URL in the browser). */
  readonly startOptions?: StartOptions;
  /** Frame scheduler for the clock. Default `requestAnimationFrame`. */
  readonly frames?: FrameScheduler;
}

export function App({
  transport,
  sessionKey,
  sessions,
  onSessionChange,
  notice = null,
  startOptions = NO_START_OPTIONS,
  frames = browserFrames,
}: AppProps) {
  const [clock] = useState<Clock>(() => createClock());
  useClockDriver(clock, frames);
  const reducedMotion = usePrefersReducedMotion();

  const [view, setView] = useState<View | null>(null);
  const [stage, setStage] = useState<Stage>("loading");
  const [hostError, setHostError] = useState<TransportError | null>(null);
  const [fileError, setFileError] = useState<FileLoadError | null>(null);
  const [selected, setSelected] = useState<ReplayAgentId | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const generationRef = useRef(0);
  const startRef = useRef<StartOptions | null>(startOptions);
  const reducedRef = useRef(reducedMotion);
  const stopHostRef = useRef<Unsubscribe | null>(null);
  const dragDepth = useRef(0);
  /** Bumped to open the same session again (after a dropped file replaced it). */
  const [reopen, setReopen] = useState(0);
  /** Text of the polite live region (`announce.ts`). */
  const [announcement, setAnnouncement] = useState("");
  const announcedLiveRef = useRef<LiveStatus | null>(null);
  const announcedAgentsRef = useRef(0);
  const agentsAnnouncedAtRef = useRef(-Infinity);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const playButtonId = useId();
  /** The model shown last, so the next snapshot can carry the playhead through real time. */
  const modelRef = useRef<ReplayModel | null>(null);

  const openSummary =
    sessionKey === undefined ? undefined : sessions?.find((entry) => entry.key === sessionKey);
  const openLabel = openSummary?.projectLabel ?? "Session";
  const openLive: LiveStatus | null = openSummary?.live ?? null;

  useEffect(() => {
    reducedRef.current = reducedMotion;
  }, [reducedMotion]);

  /**
   * Show a different replay: new generation, clock reset, start options on the first one. A
   * running host session opens at the live edge, following it, unless the start options name a
   * time or ask for `paused` (an explicit link position wins).
   */
  const replaceModel = useCallback(
    (model: ReplayModel, source: ReplaySource) => {
      const options = startRef.current ?? NO_START_OPTIONS;
      startRef.current = null;
      generationRef.current += 1;
      modelRef.current = model;
      const live = source.kind === "host" && isFollowable(source.live);
      const following = live && options.time === null && !options.paused;
      clock.reset({
        duration: model.totals.duration,
        time: options.time ?? 0,
        ...(options.rate !== null ? { rate: options.rate } : {}),
        // Reduced motion: no autoplay. Following holds at the live edge and only jumps.
        playing: !options.paused && !reducedRef.current,
        live,
        following,
      });
      setSelected(startSelection(options, model));
      setView({ model, generation: generationRef.current, source });
      setStage("ready");
      announcedLiveRef.current = source.kind === "host" ? source.live : null;
      announcedAgentsRef.current = model.agents.length;
      agentsAnnouncedAtRef.current = -Infinity;
      const loaded = loadedAnnouncement(sourceLabel(source), model);
      setAnnouncement(following ? `${loaded} ${FOLLOW_ANNOUNCEMENTS.entered}` : loaded);
    },
    [clock],
  );

  // Say once when the view starts or stops following the live edge (not per snapshot).
  useEffect(() => {
    let before = clock.getState().following;
    return clock.subscribe(() => {
      const state = clock.getState();
      if (state.following === before) return;
      const text = followAnnouncement(before, state.following, state.live);
      before = state.following;
      if (text !== null) setAnnouncement(text);
    });
  }, [clock]);

  /** Say that a followed session changed state or gained agents. Rate-limited for agents. */
  const announceLive = useCallback((live: LiveStatus, model: ReplayModel | null) => {
    const parts: string[] = [];
    const before = announcedLiveRef.current;
    if (before !== null) {
      const status = liveStatusAnnouncement(before, live);
      if (status !== null) parts.push(status);
    }
    announcedLiveRef.current = live;
    const now = Date.now();
    if (model !== null && now - agentsAnnouncedAtRef.current >= LIVE_ANNOUNCE_INTERVAL_MS) {
      const added = newAgentsAnnouncement(announcedAgentsRef.current, model);
      if (added !== null) {
        parts.push(added);
        announcedAgentsRef.current = model.agents.length;
        agentsAnnouncedAtRef.current = now;
      }
    }
    if (parts.length > 0) setAnnouncement(parts.join(" "));
  }, []);

  /**
   * A newer snapshot of the session already shown. The playhead keeps its real moment: through
   * real time onto the new timeline, so a new idle cut never moves it backwards. While following,
   * the clock then catches up to the new edge (a jump under reduced motion).
   */
  const updateModel = useCallback(
    (model: ReplayModel, live: LiveStatus) => {
      const previous = modelRef.current;
      modelRef.current = model;
      const state = clock.getState();
      const time =
        previous === null
          ? state.time
          : state.following
            ? followStartTime(previous.warps, state.time, model.warps)
            : remapTime(previous.warps, state.time, model.warps);
      clock.applySnapshot({
        duration: model.totals.duration,
        time,
        animate: !reducedRef.current,
      });
      if (live === "ended") clock.setLive(false);
      else if (isFollowable(live)) clock.setLive(true);
      setView((current) =>
        current === null || current.source.kind !== "host"
          ? current
          : { ...current, model, source: { ...current.source, live } },
      );
      setSelected((id) =>
        id !== null && model.agents.some((agent) => agent.id === id) ? id : null,
      );
      announceLive(live, model);
    },
    [clock, announceLive],
  );

  // Show a host session: follow it when it is (or may be) live, read it once when it ended.
  useEffect(() => {
    let cancelled = false;
    let stop: Unsubscribe | null = null;

    const follow = (key: string, label: string): void => {
      let first = true;
      stop = transport.subscribe(key, (update) => {
        if (cancelled) return;
        if (update.type === "replay") {
          if (first) replaceModel(update.replay, { kind: "host", label, live: update.live });
          else updateModel(update.replay, update.live);
          first = false;
          setHostError(null);
        } else if (update.type === "ended") {
          clock.setLive(false);
          if (announcedLiveRef.current === "busy" || announcedLiveRef.current === "idle") {
            announceLive("ended", null);
          }
          setView((current) =>
            current !== null &&
            current.source.kind === "host" &&
            (current.source.live === "busy" || current.source.live === "idle")
              ? { ...current, source: { ...current.source, live: "ended" } }
              : current,
          );
        } else {
          setHostError(update.error);
          if (first) setStage("error");
        }
      });
      stopHostRef.current = () => stop?.();
    };

    const load = (key: string, label: string): void => {
      let stopped = false;
      stop = () => {
        stopped = true;
      };
      stopHostRef.current = stop;
      transport.loadReplay(key).then(
        (model) => {
          if (cancelled || stopped) return;
          replaceModel(model, { kind: "host", label, live: "ended" });
          setHostError(null);
        },
        (error: unknown) => {
          if (cancelled || stopped) return;
          setHostError(asTransportError(error));
          setStage("error");
        },
      );
    };

    const open = (key: string, label: string, live: LiveStatus | null): void => {
      if (live === "ended") load(key, label);
      else follow(key, label);
    };

    setStage("loading");
    if (sessionKey !== undefined) {
      open(sessionKey, openLabel, openLive);
    } else {
      transport.listSessions({ limit: 1 }).then(
        (listed) => {
          if (cancelled) return;
          const first = listed[0];
          if (first === undefined) setStage("empty");
          else open(first.key, first.projectLabel, first.live);
        },
        (error: unknown) => {
          if (cancelled) return;
          setHostError(asTransportError(error));
          setStage("error");
        },
      );
    }
    return () => {
      cancelled = true;
      stop?.();
      stopHostRef.current = null;
    };
  }, [
    transport,
    sessionKey,
    openLabel,
    openLive,
    reopen,
    clock,
    replaceModel,
    updateModel,
    announceLive,
  ]);

  const pickSession = useCallback(
    (key: string) => {
      setFileError(null);
      if (key === sessionKey) setReopen((count) => count + 1);
      else onSessionChange?.(key);
    },
    [sessionKey, onSessionChange],
  );

  const openFile = useCallback(
    async (file: File) => {
      const result = await loadFile(file);
      if (!result.ok) {
        setFileError(result.error);
        return;
      }
      // A dropped file takes over from the host session.
      stopHostRef.current?.();
      stopHostRef.current = null;
      setFileError(null);
      setHostError(null);
      replaceModel(result.model, { kind: "file", fileKind: result.kind, name: file.name });
    },
    [replaceModel],
  );

  // Keyboard: space plays and pauses, arrows scrub.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || targetHandlesKey(event.target, event.key)) return;
      const action = keyAction(event);
      if (action === null || view === null) return;
      event.preventDefault();
      switch (action.type) {
        case "toggle":
          clock.toggle();
          break;
        case "seekBy":
          clock.seekBy(action.delta);
          break;
        case "seekTo":
          // End in a running session goes live: the edge, followed.
          if (action.to === "start") clock.seek(0);
          else clock.seekEnd();
          break;
        case "clearSelection":
          // The Clear selection button goes away with the selection: keep focus in the inspector.
          if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement.classList.contains(CLEAR_SELECTION_CLASS)
          ) {
            document.getElementById(INSPECTOR_HEADING_ID)?.focus();
          }
          setSelected(null);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clock, view]);

  const hasFiles = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onDragEnter = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file !== undefined) void openFile(file);
  };

  const source = view?.source;
  const live = source?.kind === "host" && isLiveStatus(source.live);

  return (
    <ClockContext.Provider value={clock}>
      <div
        className="app"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <header className="app-header">
          {view !== null && stage === "ready" ? (
            <button
              type="button"
              className="skip-link"
              onClick={() => document.getElementById(playButtonId)?.focus()}
            >
              {APP_MESSAGES.skipToControls}
            </button>
          ) : null}
          <img className="app-mark" src="orbitrace-mark.svg" alt="" width={24} height={24} />
          <h1 className="app-title">Orbitrace</h1>
          {source !== undefined ? (
            <p className="app-source">
              <span>{sourceLabel(source)}</span>
              {source.kind === "host" && view !== null ? (
                <LiveBadge live={source.live} model={view.model} />
              ) : null}
              {source.kind === "file" && source.fileKind === "transcript" ? (
                <span className="muted">{APP_MESSAGES.transcriptNote}</span>
              ) : null}
            </p>
          ) : null}
          {notice !== null ? (
            <p className="app-notice muted" role="status">
              {notice}
            </p>
          ) : null}
          {sessions !== undefined && sessions.length > 0 && onSessionChange !== undefined ? (
            <SessionPicker
              sessions={sessions}
              currentKey={source?.kind === "host" ? sessionKey : undefined}
              onSelect={pickSession}
            />
          ) : null}
          <button
            ref={openButtonRef}
            type="button"
            className="open-button"
            onClick={() => fileInputRef.current?.click()}
          >
            Open file
          </button>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".json,.jsonl,application/json"
            tabIndex={-1}
            aria-label="Open a replay or transcript file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void openFile(file);
            }}
          />
        </header>

        {fileError !== null ? (
          <div className="alert" role="alert">
            <div>
              <p className="alert-title">{fileError.title}</p>
              {fileError.problems.length > 0 ? (
                <ul className="alert-problems">
                  {fileError.problems.map((problem, index) => (
                    <li key={index}>{problem}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                openButtonRef.current?.focus();
                setFileError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {hostError !== null && stage === "ready" ? (
          <div className="alert" role="alert">
            <p className="alert-title">
              {hostError.message} <span className="muted">({hostError.code})</span>
            </p>
            <button
              type="button"
              onClick={() => {
                openButtonRef.current?.focus();
                setHostError(null);
              }}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {view !== null && stage === "ready" ? (
          <main className="app-main">
            <div className="stage">
              <OrreryView
                model={view.model}
                generation={view.generation}
                selected={selected}
                onSelect={setSelected}
                reducedMotion={reducedMotion}
              />
            </div>
            <div className="dock">
              <Controls model={view.model} playButtonId={playButtonId} />
              <Timeline model={view.model} selected={selected} onSelect={setSelected} />
            </div>
            <aside className="side">
              <Inspector model={view.model} selected={selected} onSelect={setSelected} />
              <EventFeed model={view.model} onSelect={setSelected} />
            </aside>
          </main>
        ) : (
          <main className="app-main app-main-message">
            {/* Keyed by stage: a new element, so the change of role and text is announced. */}
            <div key={stage} className="message" role={stage === "error" ? "alert" : "status"}>
              {stage === "loading" ? <p>{APP_MESSAGES.loading}</p> : null}
              {stage === "empty" ? <p className="message-title">{APP_MESSAGES.empty}</p> : null}
              {stage === "error" ? (
                <p className="message-title">
                  {hostError?.message ?? APP_MESSAGES.hostFailed}{" "}
                  {hostError !== null ? <span className="muted">({hostError.code})</span> : null}
                </p>
              ) : null}
              {stage !== "loading" ? <p className="muted">{APP_MESSAGES.dropHint}</p> : null}
            </div>
          </main>
        )}

        <footer className="app-footer">
          <span>
            <kbd>Space</kbd> play or pause <kbd>{"←"}</kbd> <kbd>{"→"}</kbd> scrub 5 s (
            <kbd>Shift</kbd> 30 s) <kbd>Esc</kbd> clear selection
            {live ? (
              <>
                {" "}
                <kbd>End</kbd> go live
              </>
            ) : null}
          </span>
          <span>{APP_MESSAGES.notAffiliated}</span>
        </footer>

        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>

        {dragging ? (
          <div className="drop-overlay" aria-hidden="true">
            <p>{APP_MESSAGES.dropHere}</p>
          </div>
        ) : null}
      </div>
    </ClockContext.Provider>
  );
}
