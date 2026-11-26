/**
 * The bundled demo session: the golden replay of the synthetic `demo` fixture session, copied
 * into `src/generated/demo.replay.json` by `scripts/sync-assets.mjs`. Invented data only.
 *
 * The replay is loaded with a dynamic import, so it is a separate chunk that is fetched only
 * when the app runs with no host.
 */

import type { SessionSummary } from "@orbitrace/core";
import { createNoHostTransport, type BundledSession } from "./no-host-transport";
import type { HostTransport } from "./transport";

/** Key of the demo session in the no-host transport. */
export const DEMO_SESSION_KEY = "demo";

/** Summary of the demo. Synthetic values: there is no real session behind it. */
export const DEMO_SUMMARY: SessionSummary = {
  key: DEMO_SESSION_KEY,
  runtime: "claude-code",
  projectLabel: "Demo session",
  sessionId: DEMO_SESSION_KEY,
  lastActivity: 0,
  live: "ended",
  subagentCount: 14,
};

export const DEMO_SESSION: BundledSession = {
  summary: DEMO_SUMMARY,
  load: async () => (await import("./generated/demo.replay.json")).default,
};

/** The transport the app uses when it has no host: the demo session only. */
export function createDemoTransport(): HostTransport {
  return createNoHostTransport([DEMO_SESSION]);
}
