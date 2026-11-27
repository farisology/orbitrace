/**
 * One conversation on the editor-tab wire, written down once for the tests of both ends (#197).
 *
 * The app's webview transport (`packages/app`) and the editor's message host (`packages/vscode`)
 * are in different packages and must agree on every message. Each package checks its real code
 * against this conversation, so neither test imports the other package's source:
 *
 * - the app's test makes each call and expects its transport to post exactly `request`, then
 *   hands it `replies` and expects the call to end the way they say;
 * - the extension's test hands its host each `request` and expects it to post exactly `replies`.
 *
 * A change to the layout on one side fails that side's test until the conversation changes, and
 * then the other side's test fails until it follows.
 *
 * The message types and the checks come from `@orbitrace/core` and are not written a second time
 * here. No Node import, so this module also loads in a browser test environment. Every value is
 * invented.
 */
import {
  SAVE_REPLAY_METHOD,
  exportReplay,
  type ReplayModel,
  type SaveReplayRequest,
  type SessionSummary,
  type TransportMessage,
  type TransportRequest,
} from "@orbitrace/core";

/** The one session the host in the conversation can see. */
export const WIRE_SESSION: SessionSummary = {
  key: "claude-code:wire-1",
  runtime: "claude-code",
  projectLabel: "kite-workshop",
  sessionId: "synthetic-wire-session",
  lastActivity: 1_700_000_000_000,
  live: "busy",
  subagentCount: 0,
};

/** A key the host does not know. */
export const WIRE_UNKNOWN_KEY = "claude-code:wire-missing";

/** The replay of `WIRE_SESSION`: the main agent and two tool calls. Valid replay v1. */
export const WIRE_REPLAY: ReplayModel = {
  formatVersion: 1,
  agents: [
    {
      id: "main",
      name: "main",
      callsign: "main",
      model: "claude-opus-5-5",
      family: "opus",
      effort: "high",
      parent: null,
      wave: null,
      start: 0,
      end: 12,
      tools: [
        { name: "Read", kind: "read", start: 2, end: 2.5, failed: false },
        { name: "Edit", kind: "edit", start: 6, end: 7.25, failed: false },
      ],
      replies: [
        { t: 1, inputTokens: 40, outputTokens: 120, cacheReadTokens: 0, cacheCreationTokens: 300 },
        { t: 9, inputTokens: 20, outputTokens: 80, cacheReadTokens: 300, cacheCreationTokens: 0 },
      ],
      totals: {
        toolCalls: 2,
        failedToolCalls: 0,
        replies: 2,
        inputTokens: 60,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheCreationTokens: 300,
      },
    },
  ],
  warps: [],
  totals: {
    toolCalls: 2,
    failedToolCalls: 0,
    replies: 2,
    inputTokens: 60,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheCreationTokens: 300,
    agents: 1,
    duration: 12,
    realDuration: 12,
  },
};

/**
 * The text of every error in the conversation. An error's text is for display and each host
 * words its own, so it is not part of the layout: a host's test replaces its texts with this one
 * (`withWireErrorText`) before it compares.
 */
export const WIRE_ERROR_TEXT = "Synthetic error text, for display only.";

/** A save request's text that is JSON but not a valid replay. The host refuses it. */
export const WIRE_INVALID_SAVE_DATA = '{"formatVersion":99}';

/** One request from the app and everything the editor's host posts back for it. */
export interface WireExchange {
  /** What the exchange shows. Unique in a conversation. */
  readonly name: string;
  /** The message the app's transport posts. */
  readonly request: TransportRequest | SaveReplayRequest;
  /**
   * What the host posts back, in order: the reply to `request` first, then, for a `subscribe`,
   * its live messages as the session changes.
   */
  readonly replies: readonly TransportMessage[];
}

/**
 * The conversation, in the order the app holds it. The request ids count up from 1 because the
 * app's transport numbers its requests that way, and a `subscribe` request's id is the
 * subscription id of its live messages.
 */
export const EDITOR_WIRE_CONVERSATION: readonly WireExchange[] = [
  {
    name: "lists the sessions",
    request: { id: 1, method: "listSessions", params: {} },
    replies: [{ kind: "result", id: 1, result: [WIRE_SESSION] }],
  },
  {
    name: "lists the sessions with options",
    request: { id: 2, method: "listSessions", params: { options: { limit: 1 } } },
    replies: [{ kind: "result", id: 2, result: [WIRE_SESSION] }],
  },
  {
    name: "loads a replay",
    request: { id: 3, method: "loadReplay", params: { key: WIRE_SESSION.key } },
    replies: [{ kind: "result", id: 3, result: WIRE_REPLAY }],
  },
  {
    name: "answers not-found for a key the host does not know",
    request: { id: 4, method: "loadReplay", params: { key: WIRE_UNKNOWN_KEY } },
    replies: [{ kind: "error", id: 4, error: { code: "not-found", message: WIRE_ERROR_TEXT } }],
  },
  {
    name: "follows a session until it ends",
    request: { id: 5, method: "subscribe", params: { key: WIRE_SESSION.key } },
    replies: [
      { kind: "result", id: 5, result: null },
      {
        kind: "live",
        subscriptionId: 5,
        key: WIRE_SESSION.key,
        update: { type: "replay", replay: WIRE_REPLAY, live: "busy" },
      },
      {
        kind: "live",
        subscriptionId: 5,
        key: WIRE_SESSION.key,
        update: { type: "replay", replay: WIRE_REPLAY, live: "idle" },
      },
      { kind: "live", subscriptionId: 5, key: WIRE_SESSION.key, update: { type: "ended" } },
    ],
  },
  {
    name: "follows a session a second time",
    request: { id: 6, method: "subscribe", params: { key: WIRE_SESSION.key } },
    replies: [
      { kind: "result", id: 6, result: null },
      {
        kind: "live",
        subscriptionId: 6,
        key: WIRE_SESSION.key,
        update: { type: "replay", replay: WIRE_REPLAY, live: "busy" },
      },
    ],
  },
  {
    name: "stops following by subscription id",
    request: { id: 7, method: "unsubscribe", params: { subscriptionId: 6 } },
    replies: [{ kind: "result", id: 7, result: null }],
  },
  {
    name: "answers unsupported to opening in a browser",
    request: { id: 8, method: "openInBrowser", params: {} },
    replies: [{ kind: "error", id: 8, error: { code: "unsupported", message: WIRE_ERROR_TEXT } }],
  },
  {
    name: "saves an exported replay",
    request: {
      id: 9,
      method: SAVE_REPLAY_METHOD,
      params: { data: exportReplay(WIRE_REPLAY, { names: "opaque", roundTimes: 0.1 }).data },
    },
    replies: [{ kind: "result", id: 9, result: { outcome: "saved" } }],
  },
  {
    name: "says cancelled when the user closes the save dialog",
    request: {
      id: 10,
      method: SAVE_REPLAY_METHOD,
      params: { data: exportReplay(WIRE_REPLAY).data },
    },
    replies: [{ kind: "result", id: 10, result: { outcome: "cancelled" } }],
  },
  {
    name: "refuses to save text that is not a replay",
    request: { id: 11, method: SAVE_REPLAY_METHOD, params: { data: WIRE_INVALID_SAVE_DATA } },
    replies: [{ kind: "error", id: 11, error: { code: "invalid", message: WIRE_ERROR_TEXT } }],
  },
];

/**
 * `message` with the text of its error, when it carries one, replaced by `WIRE_ERROR_TEXT`: the
 * error of an `error` reply and of a live `error` update. Any other message is returned as it is.
 */
export function withWireErrorText(message: TransportMessage): TransportMessage {
  if (message.kind === "error") {
    return { ...message, error: { ...message.error, message: WIRE_ERROR_TEXT } };
  }
  if (message.kind === "live" && message.update.type === "error") {
    const error = { ...message.update.error, message: WIRE_ERROR_TEXT };
    return { ...message, update: { ...message.update, error } };
  }
  return message;
}
