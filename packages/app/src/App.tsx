/**
 * The Orbitrace app: the orrery, the inspector, the timeline, the controls and the event feed.
 *
 * It talks to its host only through `HostTransport`: it lists sessions, follows one with
 * `subscribe` (the first update goes to `setModel`, later ones to `updateModel`) and shows the
 * errors the host reports. A file dropped or picked by the user is read in the page with core
 * and never goes through the transport.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveStatus, ReplayAgentId, ReplayModel, Unsubscribe } from "@orbitrace/core";
import { createClock, type Clock } from "./clock";
import { Controls } from "./components/Controls";
import { EventFeed } from "./components/EventFeed";
import { Inspector } from "./components/Inspector";
import { OrreryView } from "./components/OrreryView";
import { Timeline } from "./components/Timeline";
import { keyAction, targetHandlesKey } from "./keyboard";
import { loadFile, type DroppedKind, type FileLoadError } from "./load-file";
import { isTransportError, transportError } from "./no-host-transport";
import { usePrefersReducedMotion } from "./reduced-motion";
import type { HostTransport, TransportError } from "./transport";
import { ClockContext, useClockDriver, type FrameScheduler, browserFrames } from "./use-clock";
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

function asTransportError(error: unknown): TransportError {
  return isTransportError(error) ? error : transportError("internal", APP_MESSAGES.hostFailed);
}

export interface AppProps {
  readonly transport: HostTransport;
  /** Open this session. Default: the first session the host lists. */
  readonly sessionKey?: string;
  /** Applied to the first replay shown (from the URL in the browser). */
  readonly startOptions?: StartOptions;
  /** Frame scheduler for the clock. Default `requestAnimationFrame`. */
  readonly frames?: FrameScheduler;
}

export function App({
  transport,
  sessionKey,
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

  useEffect(() => {
    reducedRef.current = reducedMotion;
  }, [reducedMotion]);

  /** Show a different replay: new generation, clock reset, start options on the first one. */
  const replaceModel = useCallback(
    (model: ReplayModel, source: ReplaySource) => {
      const options = startRef.current ?? NO_START_OPTIONS;
      startRef.current = null;
      generationRef.current += 1;
      clock.reset({
        duration: model.totals.duration,
        time: options.time ?? 0,
        ...(options.rate !== null ? { rate: options.rate } : {}),
        // Reduced motion: no autoplay.
        playing: !options.paused && !reducedRef.current,
      });
      setSelected(startSelection(options, model));
      setView({ model, generation: generationRef.current, source });
      setStage("ready");
    },
    [clock],
  );

  /** A newer snapshot of the session already shown. */
  const updateModel = useCallback(
    (model: ReplayModel, live: LiveStatus) => {
      clock.setDuration(model.totals.duration);
      setView((current) =>
        current === null || current.source.kind !== "host"
          ? current
          : { ...current, model, source: { ...current.source, live } },
      );
      setSelected((id) =>
        id !== null && model.agents.some((agent) => agent.id === id) ? id : null,
      );
    },
    [clock],
  );

  // Follow a host session.
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

    setStage("loading");
    if (sessionKey !== undefined) {
      follow(sessionKey, "Session");
    } else {
      transport.listSessions({ limit: 1 }).then(
        (sessions) => {
          if (cancelled) return;
          const first = sessions[0];
          if (first === undefined) setStage("empty");
          else follow(first.key, first.projectLabel);
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
  }, [transport, sessionKey, replaceModel, updateModel]);

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
          clock.seek(action.to === "start" ? 0 : clock.getState().duration);
          break;
        case "clearSelection":
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
  const badge = source?.kind === "host" ? liveLabel(source.live) : null;

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
          <img className="app-mark" src="orbitrace-mark.svg" alt="" width={24} height={24} />
          <h1 className="app-title">Orbitrace</h1>
          {source !== undefined ? (
            <p className="app-source">
              <span>{sourceLabel(source)}</span>
              {badge !== null ? <span className="badge">{badge}</span> : null}
              {source.kind === "file" && source.fileKind === "transcript" ? (
                <span className="muted">{APP_MESSAGES.transcriptNote}</span>
              ) : null}
            </p>
          ) : null}
          <button
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
            <button type="button" onClick={() => setFileError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        {hostError !== null && stage === "ready" ? (
          <div className="alert" role="alert">
            <p className="alert-title">
              {hostError.message} <span className="muted">({hostError.code})</span>
            </p>
            <button type="button" onClick={() => setHostError(null)}>
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
              <Controls model={view.model} />
              <Timeline model={view.model} selected={selected} onSelect={setSelected} />
            </div>
            <aside className="side">
              <Inspector model={view.model} selected={selected} onSelect={setSelected} />
              <EventFeed model={view.model} onSelect={setSelected} />
            </aside>
          </main>
        ) : (
          <main className="app-main app-main-message">
            <div className="message" role={stage === "error" ? "alert" : "status"}>
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
          </span>
          <span>{APP_MESSAGES.notAffiliated}</span>
        </footer>

        {dragging ? (
          <div className="drop-overlay" aria-hidden="true">
            <p>{APP_MESSAGES.dropHere}</p>
          </div>
        ) : null}
      </div>
    </ClockContext.Provider>
  );
}
