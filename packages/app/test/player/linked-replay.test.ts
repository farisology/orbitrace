// `?replay=` links: same origin accepted, every other origin refused and never fetched.
// Hosts and paths are invented (example.test is a reserved name).

import { describe, expect, it, vi } from "vitest";
import { FILE_MESSAGES } from "../../src/load-file";
import {
  REPLAY_PARAM,
  fetchLinkedReplay,
  linkLabel,
  readLimited,
  readReplayParam,
  resolveReplayLink,
} from "../../src/player/linked-replay";
import { PLAYER_MESSAGES } from "../../src/player/messages";
import { makeModel } from "../helpers";

const PAGE = {
  href: "https://player.example.test/orbitrace/index.html?x=1",
  origin: "https://player.example.test",
};

/** `base` with a user name and password added, so no address-like literal is in this file. */
const withUser = (base: string) => {
  const url = new URL(base);
  url.username = "someone";
  url.password = "pw";
  return url.href;
};

const resolved = (raw: string) => {
  const result = resolveReplayLink(raw, PAGE);
  if (!result.ok) throw new Error(`refused: ${result.error.title}`);
  return result.url;
};

describe("readReplayParam", () => {
  it("reads the replay parameter, or null when there is none", () => {
    expect(REPLAY_PARAM).toBe("replay");
    expect(readReplayParam("?replay=replays/demo.replay.json&t=10")).toBe(
      "replays/demo.replay.json",
    );
    expect(readReplayParam("?t=10")).toBeNull();
    expect(readReplayParam("")).toBeNull();
  });
});

describe("resolveReplayLink", () => {
  it("accepts a relative path, resolved against the page's folder", () => {
    expect(resolved("replays/one.replay.json").href).toBe(
      "https://player.example.test/orbitrace/replays/one.replay.json",
    );
    expect(resolved("../shared/two.replay.json").href).toBe(
      "https://player.example.test/shared/two.replay.json",
    );
    expect(resolved("/root.replay.json").href).toBe("https://player.example.test/root.replay.json");
  });

  it("accepts an absolute URL on the same origin", () => {
    expect(resolved("https://player.example.test/a.replay.json").pathname).toBe("/a.replay.json");
  });

  it.each([
    "https://elsewhere.example.test/a.replay.json",
    "//elsewhere.example.test/a.replay.json",
    "http://player.example.test/a.replay.json",
    "https://player.example.test:8443/a.replay.json",
    // With a user name, built at run time: https://someone:pw<at>player.example.test/...
    withUser("https://player.example.test/a.replay.json"),
    "data:application/json,{}",
    "javascript:alert(1)",
    "blob:https://player.example.test/0000",
  ])("refuses %s without fetching it", (raw) => {
    const result = resolveReplayLink(raw, PAGE);
    expect(result).toEqual({
      ok: false,
      error: {
        title: PLAYER_MESSAGES.linkCrossOrigin,
        problems: [PLAYER_MESSAGES.linkCrossOriginHelp],
      },
    });
    // Fixed text only: the link itself is never echoed.
    expect(JSON.stringify(result)).not.toContain("elsewhere");
  });

  it("refuses an empty link and an unparsable one", () => {
    expect(resolveReplayLink("  ", PAGE)).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkEmpty, problems: [] },
    });
    expect(resolveReplayLink("http://[bad", PAGE)).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkInvalid, problems: [] },
    });
  });

  it("says a page opened from disk cannot open a linked replay", () => {
    const result = resolveReplayLink("a.replay.json", {
      href: "file:///srv/player/index.html",
      origin: "null",
    });
    expect(result).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkNotHttp, problems: [] },
    });
  });
});

describe("linkLabel", () => {
  it("names the file, decoded, or says Linked replay when there is no file name", () => {
    expect(linkLabel(new URL("https://player.example.test/r/two%20waves.replay.json"))).toBe(
      "Linked replay: two waves.replay.json",
    );
    expect(linkLabel(new URL("https://player.example.test/r/"))).toBe("Linked replay");
    expect(linkLabel(new URL("https://player.example.test/r/%E0%A4"))).toBe(
      "Linked replay: %E0%A4",
    );
  });
});

const response = (body: string, init: ResponseInit & { url?: string } = {}) => {
  const res = new Response(body, init);
  if (init.url !== undefined) Object.defineProperty(res, "url", { value: init.url });
  return res;
};

describe("readLimited", () => {
  it("reads a body within the limit", async () => {
    expect(await readLimited(response("hello"), 5)).toEqual({ ok: true, text: "hello" });
  });

  it("refuses a declared Content-Length over the limit before reading", async () => {
    const res = response("hello", { headers: { "content-length": "999" } });
    expect(await readLimited(res, 10)).toEqual({ ok: false, tooLarge: true });
  });

  it("stops reading a body that passes the limit with no length declared", async () => {
    expect(await readLimited(response("x".repeat(64)), 10)).toEqual({ ok: false, tooLarge: true });
  });

  it("decodes UTF-8 split across chunks", async () => {
    const bytes = new TextEncoder().encode("é".repeat(4));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await readLimited(new Response(stream), 100)).toEqual({ ok: true, text: "éééé" });
  });
});

describe("fetchLinkedReplay", () => {
  const url = new URL("https://player.example.test/orbitrace/one.replay.json");

  it("fetches a same-origin replay and checks it", async () => {
    const fetchFn = vi.fn(async () =>
      response(JSON.stringify(makeModel()), { url: url.href, status: 200 }),
    );
    const result = await fetchLinkedReplay(url, PAGE, fetchFn);
    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(url.href, { method: "GET", credentials: "same-origin" });
  });

  it("refuses a response that a redirect took to another origin", async () => {
    const fetchFn = async () =>
      response(JSON.stringify(makeModel()), { url: "https://elsewhere.example.test/x.json" });
    const result = await fetchLinkedReplay(url, PAGE, fetchFn);
    expect(result).toMatchObject({ ok: false, error: { title: PLAYER_MESSAGES.linkCrossOrigin } });
  });

  it("reports an HTTP error status", async () => {
    const result = await fetchLinkedReplay(url, PAGE, async () => response("", { status: 404 }));
    expect(result).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkFailed, problems: [PLAYER_MESSAGES.linkStatus(404)] },
    });
  });

  it("reports a network failure", async () => {
    const result = await fetchLinkedReplay(url, PAGE, async () => {
      throw new TypeError("synthetic failure");
    });
    expect(result).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkFailed, problems: [] },
    });
  });

  it("refuses a linked replay over the size limit", async () => {
    const result = await fetchLinkedReplay(url, PAGE, async () => response("x".repeat(100)), 10);
    expect(result).toEqual({
      ok: false,
      error: { title: PLAYER_MESSAGES.linkTooLarge("0.0 MB"), problems: [] },
    });
  });

  it("refuses a linked file that fails the schema, with the problem list", async () => {
    const result = await fetchLinkedReplay(url, PAGE, async () => response('{"formatVersion":1}'));
    expect(result).toMatchObject({
      ok: false,
      error: {
        title: FILE_MESSAGES.invalidReplay,
        problems: expect.arrayContaining([expect.any(String)]),
      },
    });
  });
});
