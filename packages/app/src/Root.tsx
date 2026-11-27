/**
 * What `main.tsx` renders: the app on the transport start-up selection chose.
 *
 * - Demo: the app on the bundled demo, with no session picker.
 * - Host (editor or browser): list the host's sessions first. No sessions: fall back to the
 *   demo and say why. Sessions: open the preselected one (or the newest) with a picker to
 *   switch. A refused token or any other failed listing: a plain error page, no demo.
 *
 * The start-up's saver, when it has one, gives the app its Export button (issue 168), on the demo
 * fallback too: in the editor tab that demo still saves through the extension.
 */

import { useEffect, useState } from "react";
import type { SessionSummary } from "@orbitrace/core";
import { App } from "./App";
import { asTransportError } from "./client-decode";
import { createDemoTransport } from "./demo-session";
import type { Startup } from "./startup";
import type { HostTransport, TransportError } from "./transport";
import type { FrameScheduler } from "./use-clock";
import type { StartOptions } from "./url-state";

/** How many sessions the picker lists. */
export const SESSION_LIST_LIMIT = 50;

export const ROOT_MESSAGES = {
  connecting: "Connecting to the host…",
  emptyHost: "The host lists no sessions, so this is the bundled demo.",
  refusedTitle: "This link is no longer valid.",
  refusedBody:
    "The Orbitrace server refused the link's token. A link works only with the server that printed it: start Orbitrace again and open the new link.",
  failedTitle: "Orbitrace could not reach its host.",
  listFailed: "The host could not list its sessions.",
} as const;

type Phase =
  | { readonly stage: "connecting" }
  | { readonly stage: "failed"; readonly error: TransportError }
  | {
      readonly stage: "host";
      readonly transport: HostTransport;
      readonly sessions: readonly SessionSummary[];
      readonly key: string;
    }
  | { readonly stage: "demo"; readonly transport: HostTransport; readonly notice: string | null };

export interface RootProps {
  readonly startup: Startup;
  readonly startOptions?: StartOptions;
  readonly frames?: FrameScheduler;
  /** The demo used when a host lists no sessions. Default: the bundled demo. */
  readonly createDemo?: () => HostTransport;
}

function initialPhase(startup: Startup): Phase {
  switch (startup.kind) {
    case "failed":
      return { stage: "failed", error: startup.error };
    case "demo":
      return { stage: "demo", transport: startup.transport, notice: null };
    case "host":
      return { stage: "connecting" };
  }
}

/** A page with the header and one message, for connecting and for errors. */
function PlainPage({ error }: { readonly error: TransportError | null }) {
  const refused = error?.code === "unauthorized";
  return (
    <div className="app">
      <header className="app-header">
        <img className="app-mark" src="orbitrace-mark.svg" alt="" width={24} height={24} />
        <h1 className="app-title">Orbitrace</h1>
      </header>
      <main className="app-main app-main-message">
        {error === null ? (
          <div className="message" role="status">
            <p>{ROOT_MESSAGES.connecting}</p>
          </div>
        ) : (
          <div className="message" role="alert">
            <p className="message-title">
              {refused ? ROOT_MESSAGES.refusedTitle : ROOT_MESSAGES.failedTitle}
            </p>
            <p>
              {refused ? ROOT_MESSAGES.refusedBody : error.message}{" "}
              <span className="muted">({error.code})</span>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export function Root({
  startup,
  startOptions,
  frames,
  createDemo = createDemoTransport,
}: RootProps) {
  const [phase, setPhase] = useState<Phase>(() => initialPhase(startup));
  // Kept from the first render, so a new function on each render does not list again.
  const [makeDemo] = useState(() => createDemo);

  useEffect(() => {
    if (startup.kind !== "host") return;
    let cancelled = false;
    const { transport, sessionKey } = startup;
    transport.listSessions({ limit: SESSION_LIST_LIMIT }).then(
      (sessions) => {
        if (cancelled) return;
        const first = sessions[0];
        if (first === undefined) {
          setPhase({ stage: "demo", transport: makeDemo(), notice: ROOT_MESSAGES.emptyHost });
        } else {
          setPhase({ stage: "host", transport, sessions, key: sessionKey ?? first.key });
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setPhase({ stage: "failed", error: asTransportError(error, ROOT_MESSAGES.listFailed) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [startup, makeDemo]);

  const saver = startup.kind === "failed" ? undefined : startup.saver;
  const shared = {
    ...(startOptions !== undefined ? { startOptions } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(saver !== undefined ? { saver } : {}),
  };

  switch (phase.stage) {
    case "connecting":
      return <PlainPage error={null} />;
    case "failed":
      return <PlainPage error={phase.error} />;
    case "demo":
      return <App transport={phase.transport} notice={phase.notice} {...shared} />;
    case "host":
      return (
        <App
          transport={phase.transport}
          sessionKey={phase.key}
          sessions={phase.sessions}
          onSessionChange={(key) =>
            setPhase((current) => (current.stage === "host" ? { ...current, key } : current))
          }
          {...shared}
        />
      );
  }
}
