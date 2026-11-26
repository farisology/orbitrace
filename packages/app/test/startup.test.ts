import { describe, expect, it, vi } from "vitest";
import { DEMO_SESSION_KEY } from "../src/demo-session";
import {
  STARTUP_MESSAGES,
  chooseHost,
  createStartup,
  startupFromPage,
  type StartupPage,
  type StartupWindow,
} from "../src/startup";
import { fakeWebview } from "./fake-hosts";

interface FakePage extends StartupPage {
  readonly replaced: string[];
}

function fakePage(options: { meta?: Record<string, string>; hash?: string } = {}): FakePage {
  const replaced: string[] = [];
  const location = { hash: options.hash ?? "", pathname: "/", search: "?paused" };
  return {
    document: {
      querySelector(selectors: string) {
        const match = /^meta\[name="([^"]+)"\]$/.exec(selectors);
        const content = match?.[1] !== undefined ? options.meta?.[match[1]] : undefined;
        if (content === undefined) return null;
        return { getAttribute: (name: string) => (name === "content" ? content : null) } as Element;
      },
    },
    location,
    history: {
      state: null,
      replaceState(_data, _unused, url) {
        replaced.push(String(url));
        location.hash = "";
      },
    },
    replaced,
  };
}

const TOKEN = "synthetic-token-abcdef";

describe("chooseHost", () => {
  it("selects the editor from the meta tag, with the preselected session", () => {
    const page = fakePage({
      meta: { "orbitrace-host": "editor", "orbitrace-session": "session-3" },
    });
    expect(chooseHost(page)).toEqual({ kind: "editor", sessionKey: "session-3" });
    expect(chooseHost(fakePage({ meta: { "orbitrace-host": "editor" } }))).toEqual({
      kind: "editor",
      sessionKey: null,
    });
  });

  it("selects the browser host from a token in the fragment and removes the fragment", () => {
    const page = fakePage({ hash: `#t=${TOKEN}&key=session-2` });
    expect(chooseHost(page)).toEqual({ kind: "browser", token: TOKEN, sessionKey: "session-2" });
    expect(page.replaced).toEqual(["/?paused"]);
    expect(page.location.hash).toBe("");
  });

  it("selects the demo otherwise, leaving an unrelated fragment alone", () => {
    const page = fakePage({ hash: "#notes" });
    expect(chooseHost(page)).toEqual({ kind: "demo" });
    expect(page.replaced).toEqual([]);
    expect(chooseHost(fakePage({ meta: { "orbitrace-host": "something-else" } }))).toEqual({
      kind: "demo",
    });
  });

  it("removes a fragment with a session key but no token, and shows the demo", () => {
    const page = fakePage({ hash: "#key=session-2" });
    expect(chooseHost(page)).toEqual({ kind: "demo" });
    expect(page.replaced).toEqual(["/?paused"]);
  });
});

describe("createStartup", () => {
  it("builds the webview transport for the editor", () => {
    const webview = fakeWebview();
    const acquire = vi.fn(() => webview.api);
    const startup = createStartup(
      { kind: "editor", sessionKey: "session-1" },
      { acquireWebviewApi: acquire, messageEvents: webview.events },
    );
    expect(startup).toMatchObject({ kind: "host", host: "editor", sessionKey: "session-1" });
    expect(startup.kind === "host" && startup.transport.kind).toBe("editor");
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("fails plainly when the editor page has no webview API", () => {
    expect(
      createStartup({ kind: "editor", sessionKey: null }, { messageEvents: fakeWebview().events }),
    ).toEqual({
      kind: "failed",
      error: { code: "unsupported", message: STARTUP_MESSAGES.noWebviewApi },
    });
  });

  it("builds the HTTP transport for the browser host", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => "" }) as Response);
    const startup = createStartup(
      { kind: "browser", token: TOKEN, sessionKey: null },
      { messageEvents: fakeWebview().events, fetch },
    );
    expect(startup).toMatchObject({ kind: "host", host: "browser", sessionKey: null });
    if (startup.kind !== "host") throw new Error("expected a host");
    expect(startup.transport.kind).toBe("browser");
    await expect(startup.transport.listSessions()).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("builds the demo transport otherwise", async () => {
    const startup = createStartup({ kind: "demo" }, { messageEvents: fakeWebview().events });
    if (startup.kind !== "demo") throw new Error("expected the demo");
    const sessions = await startup.transport.listSessions();
    expect(sessions.map((s) => s.key)).toEqual([DEMO_SESSION_KEY]);
  });
});

describe("startupFromPage", () => {
  function fakeWindow(page: FakePage, acquire?: () => unknown): StartupWindow {
    const webview = fakeWebview();
    return {
      ...page,
      ...webview.events,
      ...(acquire !== undefined
        ? { acquireVsCodeApi: acquire as StartupWindow["acquireVsCodeApi"] }
        : {}),
    };
  }

  it("uses the page's acquireVsCodeApi in the editor tab", () => {
    const webview = fakeWebview();
    const acquire = vi.fn(() => webview.api);
    const startup = startupFromPage(
      fakeWindow(fakePage({ meta: { "orbitrace-host": "editor" } }), acquire),
    );
    expect(startup).toMatchObject({ kind: "host", host: "editor" });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("picks the browser host from the fragment and the demo with nothing", () => {
    const page = fakePage({ hash: `#t=${TOKEN}` });
    expect(startupFromPage(fakeWindow(page))).toMatchObject({ kind: "host", host: "browser" });
    expect(page.location.hash).toBe("");
    expect(startupFromPage(fakeWindow(fakePage()))).toMatchObject({ kind: "demo" });
  });

  it("fails when the editor meta tag is there but the API is not", () => {
    expect(
      startupFromPage(fakeWindow(fakePage({ meta: { "orbitrace-host": "editor" } }))),
    ).toMatchObject({ kind: "failed" });
  });
});
