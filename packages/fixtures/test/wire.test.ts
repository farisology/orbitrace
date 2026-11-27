// The editor-tab wire conversation is checked here against core's own checks, so the tests in
// packages/app and packages/vscode can trust it as the layout both ends share (#197).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SAVE_REPLAY_METHOD,
  TRANSPORT_METHODS,
  checkSaveReplayRequest,
  checkTransportRequest,
  describeReplayProblems,
  exportReplay,
  parseSaveReplayResult,
  parseTransportMessage,
  validateReplay,
  type TransportMessage,
} from "@orbitrace/core";
import {
  EDITOR_WIRE_CONVERSATION,
  WIRE_ERROR_TEXT,
  WIRE_INVALID_SAVE_DATA,
  WIRE_REPLAY,
  WIRE_SESSION,
  WIRE_UNKNOWN_KEY,
  withWireErrorText,
} from "../src/wire.js";

const requests = EDITOR_WIRE_CONVERSATION.map((exchange) => exchange.request);
const replies = EDITOR_WIRE_CONVERSATION.flatMap((exchange) => exchange.replies);

describe("the editor-tab wire conversation", () => {
  it("names every exchange once", () => {
    const names = EDITOR_WIRE_CONVERSATION.map((exchange) => exchange.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  it("holds only requests that pass core's request checks, with nothing extra on them", () => {
    for (const request of requests) {
      const checked = checkSaveReplayRequest(request) ?? checkTransportRequest(request);
      expect(checked).toEqual({ ok: true, request });
    }
  });

  it("holds only host messages that core's message check reads back unchanged", () => {
    expect(replies.length).toBeGreaterThan(requests.length);
    for (const reply of replies) expect(parseTransportMessage(reply)).toEqual(reply);
  });

  it("numbers the requests from 1, as the app's transport does", () => {
    expect(requests.map((request) => request.id)).toEqual(requests.map((_, index) => index + 1));
  });

  it("uses every method of the protocol, and the save request", () => {
    const used = new Set<string>(requests.map((request) => request.method));
    expect([...used].sort()).toEqual([...TRANSPORT_METHODS, SAVE_REPLAY_METHOD].sort());
  });

  it("answers each request first, with a result or an error that carries its id", () => {
    const firsts = EDITOR_WIRE_CONVERSATION.map(({ replies: posted }) => posted[0]);
    expect(
      firsts.map((first) => (first !== undefined && "id" in first ? [first.kind, first.id] : [])),
    ).toEqual(
      requests.map((request, index) => [
        firsts[index]?.kind === "error" ? "error" : "result",
        request.id,
      ]),
    );
  });

  it("sends live messages only for a subscribe, after a null result, with its id and key", () => {
    const follows = EDITOR_WIRE_CONVERSATION.filter(
      ({ request }) => request.method === "subscribe",
    );
    const others = EDITOR_WIRE_CONVERSATION.filter(({ request }) => request.method !== "subscribe");
    expect(others.map(({ replies: posted }) => posted.length)).toEqual(others.map(() => 1));
    expect(follows).toHaveLength(2);
    for (const { request, replies: posted } of follows) {
      const [first, ...later] = posted;
      expect(first).toEqual({ kind: "result", id: request.id, result: null });
      expect(later.length).toBeGreaterThan(0);
      expect(later.map((message) => ({ ...message, update: null }))).toEqual(
        later.map(() => ({
          kind: "live",
          subscriptionId: request.id,
          key: "key" in request.params ? request.params.key : null,
          update: null,
        })),
      );
    }
  });

  it("sends nothing after ended, and unsubscribes only a subscription that is still open", () => {
    const open = new Set<number>();
    const problems: string[] = [];
    for (const { name, request, replies: posted } of EDITOR_WIRE_CONVERSATION) {
      if (request.method === "subscribe") {
        open.add(request.id);
        const updates = posted.flatMap((message) =>
          message.kind === "live" ? [message.update.type] : [],
        );
        const end = updates.findIndex((type) => type !== "replay");
        if (end !== -1) open.delete(request.id);
        if (end !== -1 && end !== updates.length - 1)
          problems.push(`${name}: update after the end`);
      }
      if (request.method === "unsubscribe") {
        if (!open.delete(request.params.subscriptionId)) problems.push(`${name}: not open`);
      }
    }
    expect(problems).toEqual([]);
    // Both ways a subscription closes are in the conversation, and none is left open.
    expect([...open]).toEqual([]);
    expect(replies.some((m) => m.kind === "live" && m.update.type === "ended")).toBe(true);
    expect(requests.some((request) => request.method === "unsubscribe")).toBe(true);
  });

  it("carries a valid replay and a path-free session summary", () => {
    expect(describeReplayProblems(WIRE_REPLAY)).toEqual([]);
    expect(validateReplay(WIRE_REPLAY)).toBe(true);
    expect(Object.keys(WIRE_SESSION).sort()).toEqual([
      "key",
      "lastActivity",
      "live",
      "projectLabel",
      "runtime",
      "sessionId",
      "subagentCount",
    ]);
    expect(WIRE_UNKNOWN_KEY).not.toBe(WIRE_SESSION.key);
    const sessions = requests.flatMap((request) =>
      "key" in request.params && request.params.key !== undefined ? [request.params.key] : [],
    );
    expect(new Set(sessions)).toEqual(new Set([WIRE_SESSION.key, WIRE_UNKNOWN_KEY]));
  });

  it("saves texts that core's export writes back byte for byte, and refuses one that is not a replay", () => {
    const saves = EDITOR_WIRE_CONVERSATION.filter(
      (exchange) => exchange.request.method === SAVE_REPLAY_METHOD,
    );
    const facts = saves.map(({ request, replies: posted }) => {
      const data = "data" in request.params ? request.params.data : "";
      const value: unknown = JSON.parse(data);
      const reply = posted[0];
      const result = parseSaveReplayResult(reply?.kind === "result" ? reply.result : null);
      return {
        answer: reply?.kind === "error" ? reply.error.code : result?.outcome,
        // The editor's host writes an accepted text again with exportReplay: the same bytes.
        writtenBackUnchanged: validateReplay(value) && exportReplay(value).data === data,
        isTheInvalidText: data === WIRE_INVALID_SAVE_DATA,
      };
    });
    expect(facts).toEqual([
      { answer: "saved", writtenBackUnchanged: true, isTheInvalidText: false },
      { answer: "cancelled", writtenBackUnchanged: true, isTheInvalidText: false },
      { answer: "invalid", writtenBackUnchanged: false, isTheInvalidText: true },
    ]);
    // The two saved texts differ: one was exported with the opt-in privacy options.
    expect(new Set(saves.map(({ request }) => JSON.stringify(request.params))).size).toBe(3);
  });

  it("survives a structured clone and JSON, as a message between a page and its host does", () => {
    expect(structuredClone(EDITOR_WIRE_CONVERSATION)).toEqual(EDITOR_WIRE_CONVERSATION);
    expect(JSON.parse(JSON.stringify(EDITOR_WIRE_CONVERSATION))).toEqual(EDITOR_WIRE_CONVERSATION);
  });

  it("gives every error the one stand-in text", () => {
    const texts = replies.flatMap((message) => (message.kind === "error" ? [message.error] : []));
    expect(texts.map((error) => error.code)).toEqual(["not-found", "unsupported", "invalid"]);
    expect(texts.every((error) => error.message === WIRE_ERROR_TEXT)).toBe(true);
  });
});

describe("withWireErrorText", () => {
  it("replaces the text of an error reply and keeps its id and code", () => {
    const message: TransportMessage = {
      kind: "error",
      id: 4,
      error: { code: "not-found", message: "Synthetic host wording." },
    };
    expect(withWireErrorText(message)).toEqual({
      kind: "error",
      id: 4,
      error: { code: "not-found", message: WIRE_ERROR_TEXT },
    });
    // The message it was given is not changed.
    expect(message.error.message).toBe("Synthetic host wording.");
  });

  it("replaces the text of a live error update", () => {
    const message: TransportMessage = {
      kind: "live",
      subscriptionId: 5,
      key: WIRE_SESSION.key,
      update: { type: "error", error: { code: "unreadable", message: "Synthetic host wording." } },
    };
    expect(withWireErrorText(message)).toEqual({
      kind: "live",
      subscriptionId: 5,
      key: WIRE_SESSION.key,
      update: { type: "error", error: { code: "unreadable", message: WIRE_ERROR_TEXT } },
    });
  });

  it("returns every other message as it is", () => {
    for (const reply of replies.filter((message) => message.kind !== "error")) {
      expect(withWireErrorText(reply)).toBe(reply);
    }
  });
});

describe("the wire module", () => {
  it("has no Node import and is offered as @orbitrace/fixtures/wire", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/wire.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+"node:|\brequire\(|\bprocess\.|\bBuffer\b/);
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(manifest.exports["./wire"]).toEqual({
      types: "./dist/wire.d.ts",
      default: "./dist/wire.js",
    });
  });
});
