/**
 * The public replay player: a static page that opens a shared replay file.
 *
 * - Start: an invitation to open or drop a replay file, the bundled demo as an explicit
 *   choice, one line on making a replay of your own session, and the privacy statement.
 * - `?replay=<path>`: a same-origin replay next to the page is fetched and shown; any other
 *   origin is refused with a message and never fetched (`linked-replay.ts`).
 * - Opening a file: replay files only. A `.jsonl` transcript (private content) or another file
 *   type, and a file over `MAX_REPLAY_BYTES`, are refused before it is read; a replay is then
 *   checked with the app's loader (`validateReplay`, with `describeReplayProblems` for the
 *   reasons). See `open-file.ts`.
 *
 * The player owns every way a file gets in. It listens on its outer element in the capture
 * phase for drag and drop and for `change` on a file input, so the app's own Open file button
 * and drop area (inside `App`) go through the same checks, and the app's handlers never see the
 * event. The app is shown with `transcripts={false}`, so its Open file control and drop hint
 * offer replay files only.
 *
 * Every string from a file or a link reaches the page as React text, never as HTML.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { APP_MESSAGES, App, OPEN_FILE_INPUT } from "../App";
import { createDemoTransport } from "../demo-session";
import type { FetchFunction } from "../http-transport";
import type { FileLoadError } from "../load-file";
import type { HostTransport } from "../transport";
import type { FrameScheduler } from "../use-clock";
import { NO_START_OPTIONS, type StartOptions } from "../url-state";
import {
  fetchLinkedReplay,
  linkLabel,
  readReplayParam,
  resolveReplayLink,
  type PlayerPage,
} from "./linked-replay";
import { EXPORT_COMMAND, EXPORT_DOCS_URL, PLAYER_MESSAGES } from "./messages";
import { MAX_REPLAY_BYTES, fileLabel, formatMegabytes, openPlayerFile } from "./open-file";
import { createReplayTransport } from "./replay-transport";

type View =
  | { readonly kind: "start" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "replay";
      readonly transport: HostTransport;
      /** Remounts the app for each replay opened, so nothing carries over. */
      readonly generation: number;
      readonly startOptions: StartOptions;
    };

export interface PlayerProps {
  /** The page: `window.location` in the browser. Read once, for `?replay=`. */
  readonly page: PlayerPage;
  /** Applied to the first replay shown (from the URL in the browser). */
  readonly startOptions?: StartOptions;
  readonly frames?: FrameScheduler;
  /** Used for a `?replay=` link. Default: the browser's `fetch`. */
  readonly fetch?: FetchFunction;
  /** Default: the bundled demo. */
  readonly createDemo?: () => HostTransport;
  /** Largest file or linked replay read, in bytes. Default `MAX_REPLAY_BYTES`. */
  readonly maxBytes?: number;
}

const hasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

function isFileInput(target: EventTarget | null): target is HTMLInputElement {
  return (
    target !== null &&
    (target as Element).tagName === "INPUT" &&
    (target as HTMLInputElement).type === "file"
  );
}

/** The start screen, in the app's frame: header, one centred panel, footer. */
function StartScreen({
  loading,
  maxBytes,
  onOpen,
  onDemo,
  openButtonRef,
  inputRef,
}: {
  readonly loading: boolean;
  readonly maxBytes: number;
  readonly onOpen: () => void;
  readonly onDemo: () => void;
  readonly openButtonRef: React.RefObject<HTMLButtonElement | null>;
  /** The file input; its `change` event is handled by the player's capture listener. */
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const headingId = useId();
  return (
    <div className="app">
      <header className="app-header">
        <img className="app-mark" src="orbitrace-mark.svg" alt="" width={24} height={24} />
        <h1 className="app-title">Orbitrace</h1>
        <p className="app-source">
          <span>{PLAYER_MESSAGES.subtitle}</span>
        </p>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept={OPEN_FILE_INPUT.replayOnly.accept}
          tabIndex={-1}
          aria-label={PLAYER_MESSAGES.inputLabel}
        />
      </header>
      <main className="app-main app-main-message">
        {loading ? (
          <div className="message" role="status">
            <p>{PLAYER_MESSAGES.loadingLink}</p>
          </div>
        ) : (
          <section className="message player-start" aria-labelledby={headingId}>
            <h2 id={headingId} className="message-title">
              {PLAYER_MESSAGES.title}
            </h2>
            <p>{PLAYER_MESSAGES.intro}</p>
            <div className="player-actions">
              <button ref={openButtonRef} type="button" className="player-primary" onClick={onOpen}>
                {PLAYER_MESSAGES.openButton}
              </button>
              <button type="button" onClick={onDemo}>
                {PLAYER_MESSAGES.demoButton}
              </button>
            </div>
            <p className="muted">Files up to {formatMegabytes(maxBytes)}.</p>
            <p>{PLAYER_MESSAGES.privacy}</p>
            <p className="player-own">
              {PLAYER_MESSAGES.ownReplayBefore} <code>{EXPORT_COMMAND}</code>{" "}
              {PLAYER_MESSAGES.ownReplayAfter}{" "}
              <a href={EXPORT_DOCS_URL} rel="noreferrer">
                {PLAYER_MESSAGES.ownReplayLink}
              </a>
            </p>
          </section>
        )}
      </main>
      <footer className="app-footer">
        <span>{APP_MESSAGES.notAffiliated}</span>
      </footer>
    </div>
  );
}

export function Player({
  page,
  startOptions = NO_START_OPTIONS,
  frames,
  fetch: fetchOption,
  createDemo = createDemoTransport,
  maxBytes = MAX_REPLAY_BYTES,
}: PlayerProps) {
  // Read once: the link and the options apply to the first replay shown.
  const [link] = useState(() => {
    const raw = readReplayParam(page.search);
    return raw === null ? null : resolveReplayLink(raw, page);
  });
  const [view, setView] = useState<View>(() =>
    link?.ok === true ? { kind: "loading" } : { kind: "start" },
  );
  const [error, setError] = useState<FileLoadError | null>(() =>
    link !== null && !link.ok ? link.error : null,
  );
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef<StartOptions | null>(startOptions);
  const generationRef = useRef(0);
  /** Bumped for each open; a slower earlier open never replaces a later one. */
  const openSeqRef = useRef(0);
  const dragDepth = useRef(0);
  const [pageOrigin] = useState(() => ({ origin: page.origin }));
  const [fetchFn] = useState(() => fetchOption);
  /**
   * Set when a replay opens while focus is inside the player (a start-screen button, the app's
   * Open file). Showing the replay unmounts that control, so focus goes back to the app's Open
   * file button rather than dropping to the page (WCAG 2.4.3). A `?replay=` link opened on page
   * load leaves focus where it is.
   */
  const restoreFocusRef = useRef(false);

  const show = useCallback((transport: HostTransport) => {
    const active = document.activeElement;
    restoreFocusRef.current =
      active !== null && active !== document.body && rootRef.current?.contains(active) === true;
    const options = startRef.current ?? NO_START_OPTIONS;
    startRef.current = null;
    generationRef.current += 1;
    setError(null);
    setView({
      kind: "replay",
      transport,
      generation: generationRef.current,
      startOptions: options,
    });
  }, []);

  const showDemo = useCallback(() => {
    openSeqRef.current += 1;
    show(createDemo());
  }, [createDemo, show]);

  const openFile = useCallback(
    async (file: File) => {
      const seq = ++openSeqRef.current;
      const result = await openPlayerFile(file, maxBytes);
      if (seq !== openSeqRef.current) return;
      if (!result.ok) {
        setError(result.error);
        // A refused file also ends a `?replay=` link still loading: that link's result is now
        // stale and is dropped, so leave the loading state here or nothing ever will.
        setView((current) => (current.kind === "loading" ? { kind: "start" } : current));
        return;
      }
      show(createReplayTransport(result.model, fileLabel(file.name)));
    },
    [maxBytes, show],
  );

  // After a replay opens from a control inside the player, focus its Open file button.
  useEffect(() => {
    if (view.kind !== "replay" || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    rootRef.current?.querySelector<HTMLButtonElement>(".open-button")?.focus();
  }, [view]);

  // A `?replay=` link: fetched once, same origin only.
  useEffect(() => {
    if (link === null || !link.ok) return;
    const url = link.url;
    let cancelled = false;
    const seq = ++openSeqRef.current;
    void fetchLinkedReplay(url, pageOrigin, fetchFn, maxBytes).then((result) => {
      if (cancelled || seq !== openSeqRef.current) return;
      if (result.ok) {
        show(createReplayTransport(result.model, linkLabel(url)));
      } else {
        setError(result.error);
        setView((current) => (current.kind === "loading" ? { kind: "start" } : current));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [link, pageOrigin, fetchFn, maxBytes, show]);

  // Every file that gets in, from the start screen or from inside the app, comes through here.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.stopPropagation();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) void openFile(file);
    };
    const onChange = (event: Event) => {
      if (!isFileInput(event.target)) return;
      event.stopPropagation();
      const input = event.target;
      const file = input.files?.[0];
      input.value = "";
      if (file !== undefined) void openFile(file);
    };
    root.addEventListener("dragenter", onDragEnter, true);
    root.addEventListener("dragover", onDragOver, true);
    root.addEventListener("dragleave", onDragLeave, true);
    root.addEventListener("drop", onDrop, true);
    root.addEventListener("change", onChange, true);
    return () => {
      root.removeEventListener("dragenter", onDragEnter, true);
      root.removeEventListener("dragover", onDragOver, true);
      root.removeEventListener("dragleave", onDragLeave, true);
      root.removeEventListener("drop", onDrop, true);
      root.removeEventListener("change", onChange, true);
    };
  }, [openFile]);

  const dismiss = () => {
    setError(null);
    // Back to a control that opens a file: the start screen's, or the app's in its header.
    const target =
      openButtonRef.current ??
      rootRef.current?.querySelector<HTMLButtonElement>(".open-button") ??
      null;
    target?.focus();
  };

  return (
    <div ref={rootRef} className="player">
      {error !== null ? (
        <div className="alert" role="alert">
          <div>
            <p className="alert-title">{error.title}</p>
            {error.problems.length > 0 ? (
              <ul className="alert-problems">
                {error.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <button type="button" onClick={dismiss}>
            {PLAYER_MESSAGES.dismiss}
          </button>
        </div>
      ) : null}

      {view.kind === "replay" ? (
        <div className="player-app">
          <App
            key={view.generation}
            transport={view.transport}
            startOptions={view.startOptions}
            transcripts={false}
            {...(frames !== undefined ? { frames } : {})}
          />
        </div>
      ) : (
        <div className="player-app">
          <StartScreen
            loading={view.kind === "loading"}
            maxBytes={maxBytes}
            onOpen={() => inputRef.current?.click()}
            onDemo={showDemo}
            openButtonRef={openButtonRef}
            inputRef={inputRef}
          />
        </div>
      )}

      {dragging ? (
        <div className="drop-overlay" aria-hidden="true">
          <p>{APP_MESSAGES.dropHere}</p>
        </div>
      ) : null}
    </div>
  );
}
