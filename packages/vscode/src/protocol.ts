/**
 * Checks the shape of every message the webview sends before the host acts on it.
 *
 * The webview runs the app bundle, but a message from it is still untrusted input: the host
 * reads files for it. The check is core's `checkTransportRequest` (#92), the same one the CLI's
 * loopback server and the app use, with the same limits. This module only keeps the names it
 * exported before, as re-exports, so existing imports keep working.
 */

import { checkTransportRequest, type TransportRequestCheck } from "@orbitrace/core";

export { TRANSPORT_METHODS, isRequestId, parseListOptions } from "@orbitrace/core";
export type { RequestProblem } from "@orbitrace/core";

/** What `parseTransportRequest` found. Core's `TransportRequestCheck`. */
export type ParsedRequest = TransportRequestCheck;

/**
 * Check one incoming message. Core's `checkTransportRequest`: on success the request is a fresh
 * object holding only the known fields; on failure it says why, with the `id` when it is usable.
 */
export const parseTransportRequest: (message: unknown) => ParsedRequest = checkTransportRequest;
