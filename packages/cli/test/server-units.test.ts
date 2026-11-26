/**
 * Unit tests of the loopback server's parts: token, Host and origin checks, content types,
 * static path resolution, request parsing, the link and the browser opener.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionReplayer } from "@orbitrace/core/node";
import { SessionReplayError } from "@orbitrace/core";
import {
  allowedHosts,
  allowedOrigins,
  bearerToken,
  createToken,
  isAllowedHost,
  isJsonContentType,
  isSameOriginRequest,
  SECURITY_HEADERS,
  TOKEN_BYTES,
  tokenMatches,
} from "../src/server/security.js";
import {
  contentTypeFor,
  isInside,
  readStaticFile,
  requestSegments,
} from "../src/server/static-files.js";
import {
  handleRpc,
  MAX_KEY_LENGTH,
  parseLiveRequest,
  parseRpcRequest,
  SERVER_MESSAGES,
} from "../src/server/rpc.js";
import { buildLink, encodeFragmentValue } from "../src/server/link.js";
import {
  browserCommand,
  isOpenableFile,
  isOpenableLink,
  LAUNCHER_FILE_NAME,
  launcherHtml,
  openInBrowser,
  writeLauncherFile,
  type SpawnFunction,
} from "../src/server/browser.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

describe("token", () => {
  it("createToken makes 32 random bytes as base64url, different every time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => createToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(TOKEN_BYTES);
    }
    expect(TOKEN_BYTES).toBeGreaterThanOrEqual(32);
  });

  it("bearerToken reads the Bearer scheme only", () => {
    expect(bearerToken("Bearer abc_DEF-1")).toBe("abc_DEF-1");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
  });

  it("tokenMatches compares exactly, whatever the lengths", () => {
    const token = createToken();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(`${token}x`, token)).toBe(false);
    expect(tokenMatches(token.slice(1), token)).toBe(false);
    expect(tokenMatches("", token)).toBe(false);
    expect(tokenMatches(null, token)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("Host and origin", () => {
  it("allowedHosts and isAllowedHost accept 127.0.0.1 and localhost on the port only", () => {
    expect(allowedHosts(4000)).toEqual(["127.0.0.1:4000", "localhost:4000"]);
    expect(isAllowedHost("127.0.0.1:4000", 4000)).toBe(true);
    expect(isAllowedHost("Localhost:4000", 4000)).toBe(true);
    for (const host of [
      undefined,
      "",
      "127.0.0.1",
      "127.0.0.1:4001",
      "evil.example:4000",
      "[::1]:4000",
    ]) {
      expect(isAllowedHost(host, 4000)).toBe(false);
    }
  });

  it("allowedOrigins and isSameOriginRequest accept the server's own page only", () => {
    expect(allowedOrigins(4000)).toEqual(["http://127.0.0.1:4000", "http://localhost:4000"]);
    expect(isSameOriginRequest(undefined, undefined, 4000)).toBe(true);
    expect(isSameOriginRequest("http://127.0.0.1:4000", "same-origin", 4000)).toBe(true);
    expect(isSameOriginRequest(undefined, "none", 4000)).toBe(true);
    expect(isSameOriginRequest("http://127.0.0.1:4001", undefined, 4000)).toBe(false);
    expect(isSameOriginRequest("null", undefined, 4000)).toBe(false);
    expect(isSameOriginRequest(undefined, "same-site", 4000)).toBe(false);
    expect(isSameOriginRequest(undefined, "cross-site", 4000)).toBe(false);
  });

  it("isJsonContentType accepts application/json with a UTF-8 charset only", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("Application/JSON; charset=UTF-8")).toBe(true);
    for (const type of [
      undefined,
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "application/json; charset=latin1",
      "application/jsonp",
      "application/json; boundary=x",
    ]) {
      expect(isJsonContentType(type)).toBe(false);
    }
  });

  it("SECURITY_HEADERS hold no CORS header and forbid caching and framing", () => {
    const names = Object.keys(SECURITY_HEADERS).map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith("access-control-"))).toBe(false);
    expect(SECURITY_HEADERS["Cache-Control"]).toBe("no-store");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("static files", () => {
  it("contentTypeFor knows the app's file types", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.JS")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });

  it("requestSegments decodes once and refuses unsafe segments", () => {
    expect(requestSegments("/")).toEqual(["index.html"]);
    expect(requestSegments("/assets/a.js?x=1")).toEqual(["assets", "a.js"]);
    expect(requestSegments("/a%20b.js")).toEqual(["a b.js"]);
    for (const target of [
      "",
      "assets/a.js",
      "/../a",
      "/a/../b",
      "/%2e%2e/a",
      "/a%2f..%2fb",
      "/a\\b",
      "/a%5cb",
      "/a%00b",
      "/.env",
      "/a//b",
      "/a/",
      "/%",
      "/C:/x",
      "http://example/a",
    ]) {
      expect(requestSegments(target)).toBeNull();
    }
  });

  it("isInside tells a path inside a folder from one outside it", () => {
    const root = join(makeTempDir(), "root");
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "a", "b"))).toBe(true);
    expect(isInside(root, join(root, "..", "x"))).toBe(false);
    expect(isInside(root, `${root}-sibling`)).toBe(false);
    expect(isInside(root, join(root, "..dots"))).toBe(true);
  });

  it("readStaticFile reads regular files inside the folder only", async () => {
    const base = makeTempDir();
    const root = join(base, "app");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "index.html"), "home");
    writeFileSync(join(root, "sub", "a.js"), "js");
    writeFileSync(join(base, "outside.txt"), "outside");
    const real = realpathSync(root);
    expect(await readStaticFile(real, "/")).toEqual({
      name: "index.html",
      data: Buffer.from("home"),
    });
    expect((await readStaticFile(real, "/sub/a.js"))?.data.toString()).toBe("js");
    expect(await readStaticFile(real, "/sub")).toBeNull();
    expect(await readStaticFile(real, "/missing")).toBeNull();
    expect(await readStaticFile(real, "/../outside.txt")).toBeNull();
    expect(await readStaticFile(real, "/%2e%2e/outside.txt")).toBeNull();
  });
});

describe("request parsing", () => {
  it("parseRpcRequest accepts the TransportRequest shapes", () => {
    expect(parseRpcRequest({ id: 1, method: "listSessions", params: {} })).toEqual({
      id: 1,
      method: "listSessions",
      params: {},
    });
    expect(
      parseRpcRequest({
        id: 2,
        method: "listSessions",
        params: { options: { limit: 3, since: 5 } },
      }),
    ).toEqual({ id: 2, method: "listSessions", params: { options: { limit: 3, since: 5 } } });
    expect(parseRpcRequest({ id: 3, method: "loadReplay", params: { key: "k" } })).toEqual({
      id: 3,
      method: "loadReplay",
      params: { key: "k" },
    });
    expect(parseRpcRequest({ id: 4, method: "subscribe", params: { key: "k" } })?.method).toBe(
      "subscribe",
    );
    expect(
      parseRpcRequest({ id: 5, method: "unsubscribe", params: { subscriptionId: 4 } }),
    ).toEqual({ id: 5, method: "unsubscribe", params: { subscriptionId: 4 } });
    expect(parseRpcRequest({ id: 6, method: "openInBrowser", params: { key: "k" } })).toEqual({
      id: 6,
      method: "openInBrowser",
      params: { key: "k" },
    });
    // Unknown extra fields are dropped, not passed on.
    expect(
      parseRpcRequest({ id: 7, method: "loadReplay", params: { key: "k", path: "/x" }, extra: 1 }),
    ).toEqual({ id: 7, method: "loadReplay", params: { key: "k" } });
  });

  it("parseRpcRequest refuses anything else", () => {
    for (const body of [
      null,
      [],
      "x",
      { id: 1.5, method: "listSessions", params: {} },
      { id: "1", method: "listSessions", params: {} },
      { id: 1, method: "listSessions" },
      { id: 1, method: "listSessions", params: { options: { limit: 0 } } },
      { id: 1, method: "listSessions", params: { options: { since: "x" } } },
      { id: 1, method: "listSessions", params: { options: [] } },
      { id: 1, method: "loadReplay", params: {} },
      { id: 1, method: "loadReplay", params: { key: "" } },
      { id: 1, method: "loadReplay", params: { key: "k".repeat(MAX_KEY_LENGTH + 1) } },
      { id: 1, method: "unsubscribe", params: { subscriptionId: -1 } },
      { id: 1, method: "openInBrowser", params: { key: 3 } },
      { id: 1, method: "toString", params: {} },
    ]) {
      expect(parseRpcRequest(body)).toBeNull();
    }
  });

  it("parseLiveRequest takes an id and a key", () => {
    expect(parseLiveRequest({ id: 3, key: "k" })).toEqual({ id: 3, key: "k" });
    for (const body of [null, { id: 3 }, { key: "k" }, { id: -3, key: "k" }, { id: 3, key: "" }]) {
      expect(parseLiveRequest(body)).toBeNull();
    }
  });
});

describe("handleRpc", () => {
  const replayer: SessionReplayer = {
    list: async (options) => [
      {
        key: "claude-code:example",
        runtime: "claude-code",
        projectLabel: "example-project",
        sessionId: "example-session",
        lastActivity: options?.since ?? 0,
        live: "unknown",
        subagentCount: 0,
      },
    ],
    find: async () => {
      throw new SessionReplayError("not-found", "No session with that key.");
    },
    load: async () => {
      throw new Error("a message naming a folder that must not be sent");
    },
    follow: () => () => undefined,
  };

  it("answers each method with one TransportMessage", async () => {
    const stopped: number[] = [];
    const context = { replayer, unsubscribe: (id: number) => stopped.push(id) };
    const list = await handleRpc({ id: 1, method: "listSessions", params: {} }, context);
    expect(list).toMatchObject({ kind: "result", id: 1 });
    const load = await handleRpc({ id: 2, method: "loadReplay", params: { key: "k" } }, context);
    expect(load).toEqual({
      kind: "error",
      id: 2,
      error: { code: "internal", message: "Something went wrong while handling the session." },
    });
    expect(
      await handleRpc({ id: 3, method: "unsubscribe", params: { subscriptionId: 9 } }, context),
    ).toEqual({
      kind: "result",
      id: 3,
      result: null,
    });
    expect(stopped).toEqual([9]);
    expect(await handleRpc({ id: 4, method: "subscribe", params: { key: "k" } }, context)).toEqual({
      kind: "error",
      id: 4,
      error: { code: "unsupported", message: SERVER_MESSAGES.subscribeOverRpc },
    });
    expect(await handleRpc({ id: 5, method: "openInBrowser", params: {} }, context)).toEqual({
      kind: "error",
      id: 5,
      error: { code: "unsupported", message: SERVER_MESSAGES.openInBrowser },
    });
  });
});

describe("link", () => {
  it("encodeFragmentValue keeps the plain characters and encodes the rest", () => {
    expect(encodeFragmentValue("claude-code:abc_1.2~")).toBe("claude-code:abc_1.2~");
    expect(encodeFragmentValue("a b+c&d=e#f%")).toBe("a%20b%2Bc%26d%3De%23f%25");
    expect(encodeFragmentValue("é")).toBe("%C3%A9");
    expect(new URLSearchParams(`k=${encodeFragmentValue("a+b &c")}`).get("k")).toBe("a+b &c");
  });

  it("buildLink puts the token and the key in the fragment", () => {
    expect(buildLink("http://127.0.0.1:5000", "tok")).toBe("http://127.0.0.1:5000/#t=tok");
    const link = buildLink("http://127.0.0.1:5000", "tok", "claude-code:ab");
    expect(link).toBe("http://127.0.0.1:5000/#t=tok&key=claude-code:ab");
    const url = new URL(link);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get("t")).toBe("tok");
    expect(fragment.get("key")).toBe("claude-code:ab");
  });
});

describe("browser opener", () => {
  const token = "abc_DEF-1tokenTOKENtoken0123456789abcdefXYZ";
  const link = `http://127.0.0.1:5000/#t=${token}&key=claude-code:ab12`;
  const darwinFile = "/var/folders/xx/T/orbitrace-open-AbC123/open.html";
  const windowsFile = "D:\\Temp Files\\orbitrace-open-AbC123\\open.html";

  it("isOpenableLink accepts the CLI's own links only", () => {
    expect(isOpenableLink(link)).toBe(true);
    expect(isOpenableLink("http://127.0.0.1:5000/")).toBe(true);
    for (const bad of [
      "http://127.0.0.1:5000/#t=a%22b",
      'http://127.0.0.1:5000/#t=a"&calc',
      "http://127.0.0.1:5000/#t=a b",
      "http://127.0.0.1:5000/#t=a^b",
      "http://127.0.0.1:5000/#t=a!b",
      "https://example.com/",
      "file:///etc/passwd",
      "-a http://127.0.0.1:5000/",
      "http://127.0.0.1:5000/x",
    ]) {
      expect(isOpenableLink(bad)).toBe(false);
    }
  });

  it("isOpenableFile accepts an absolute .html path only, and nothing cmd.exe would read", () => {
    expect(isOpenableFile("darwin", darwinFile)).toBe(true);
    expect(isOpenableFile("linux", "/tmp/with space/orbitrace-open-x/open.html")).toBe(true);
    expect(isOpenableFile("win32", windowsFile)).toBe(true);
    expect(isOpenableFile("win32", "C:\\a&b\\open.html")).toBe(true);
    for (const [platform, bad] of [
      ["darwin", link],
      ["linux", link],
      ["win32", link],
      ["linux", "relative/open.html"],
      ["linux", "-a/open.html"],
      ["linux", "/tmp/open.txt"],
      ["linux", "/tmp/a\nb/open.html"],
      ["darwin", "/tmp/a\u0000b/open.html"],
      ["win32", "/tmp/open.html"],
      ["win32", "\\\\server\\share\\open.html"],
      ["win32", "C:\\a%PATH%\\open.html"],
      ["win32", 'C:\\a"&calc&"\\open.html'],
      ["win32", "C:\\a!b\\open.html"],
      ["win32", "C:\\a^b\\open.html"],
    ] as const) {
      expect(isOpenableFile(platform, bad)).toBe(false);
    }
  });

  it("browserCommand uses open, xdg-open and cmd start on the launcher file, never a link or a shell string", () => {
    expect(browserCommand("darwin", darwinFile)).toEqual({
      command: "open",
      args: [darwinFile],
      windowsVerbatimArguments: false,
    });
    expect(browserCommand("linux", darwinFile)).toEqual({
      command: "xdg-open",
      args: [darwinFile],
      windowsVerbatimArguments: false,
    });
    expect(browserCommand("freebsd", darwinFile)?.command).toBe("xdg-open");
    expect(browserCommand("win32", windowsFile)).toEqual({
      command: "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `"start "" "${windowsFile}""`],
      windowsVerbatimArguments: true,
    });
    // A link would put the token in a command line: refused on every platform.
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(browserCommand(platform, link)).toBeNull();
    }
    expect(browserCommand("win32", 'C:\\x"&calc\\open.html')).toBeNull();
  });

  it("launcherHtml redirects to the link with the fragment kept, escaped, and without script", () => {
    const html = launcherHtml(link);
    const escaped = link.replaceAll("&", "&amp;");
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${escaped}">`);
    expect(html).toContain(`<a href="${escaped}">`);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toContain("<script");
    expect(html.replaceAll("&amp;", "")).not.toContain("&");
    expect(() => launcherHtml('http://127.0.0.1:5000/#t="><script>')).toThrow(TypeError);
    expect(() => launcherHtml("https://example.com/")).toThrow(TypeError);
  });

  it("writeLauncherFile writes a 0600 page in a fresh 0700 folder and removes both", async () => {
    const base = makeTempDir();
    const launcher = await writeLauncherFile(link, { tmpDir: base });
    expect(launcher.path.startsWith(join(base, "orbitrace-open-"))).toBe(true);
    expect(basename(launcher.path)).toBe(LAUNCHER_FILE_NAME);
    expect(readFileSync(launcher.path, "utf8")).toBe(launcherHtml(link));
    expect(launcher.path).not.toContain(token);
    const second = await writeLauncherFile(link, { tmpDir: base });
    expect(dirname(second.path)).not.toBe(dirname(launcher.path));
    await launcher.remove();
    await launcher.remove();
    expect(existsSync(dirname(launcher.path))).toBe(false);
    await second.remove();
    expect(readdirSync(base)).toEqual([]);

    await expect(writeLauncherFile("https://example.com/", { tmpDir: base })).rejects.toThrow(
      TypeError,
    );
    await expect(writeLauncherFile(link, { tmpDir: "relative" })).rejects.toThrow(TypeError);
    await expect(writeLauncherFile(link, { tmpDir: join(base, "missing") })).rejects.toThrow();
    expect(readdirSync(base)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "writeLauncherFile makes the page readable by this user only (another account reading it)",
    async () => {
      const launcher = await writeLauncherFile(link, { tmpDir: makeTempDir() });
      expect(statSync(launcher.path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(launcher.path)).mode & 0o777).toBe(0o700);
      await launcher.remove();
    },
  );

  function fakeSpawn(outcome: "spawn" | "error" | "throw") {
    const calls: { command: string; args: readonly string[]; options: object }[] = [];
    let unrefs = 0;
    const spawn: SpawnFunction = (command, args, options) => {
      calls.push({ command, args, options });
      if (outcome === "throw") throw new Error("spawn failed");
      const child = {
        once(event: string, listener: (error?: Error) => void) {
          if (event === outcome) queueMicrotask(() => listener(new Error("missing")));
          return child;
        },
        unref() {
          unrefs += 1;
        },
      };
      return child;
    };
    return { spawn, calls, unrefs: () => unrefs };
  }

  it("openInBrowser never puts the token in the opener's arguments (another account reading the process list)", async () => {
    for (const platform of ["darwin", "linux"]) {
      const base = makeTempDir();
      const ok = fakeSpawn("spawn");
      const opening = await openInBrowser(link, { platform, spawn: ok.spawn, tmpDir: base });
      expect(opening.result).toBe("opened");
      expect(ok.calls).toHaveLength(1);
      const call = ok.calls[0] as { command: string; args: readonly string[] };
      expect(JSON.stringify(call)).not.toContain(token);
      expect(call.args.join(" ")).not.toContain("127.0.0.1");
      const [file] = call.args;
      expect(file?.startsWith(join(base, "orbitrace-open-"))).toBe(true);
      // The page the opener got leads to the link.
      expect(readFileSync(file as string, "utf8")).toBe(launcherHtml(link));
      await opening.close();
      expect(existsSync(file as string)).toBe(false);
      expect(readdirSync(base)).toEqual([]);
    }
  });

  it("openInBrowser spawns without a shell, detached, and reports the outcome", async () => {
    const base = makeTempDir();
    const ok = fakeSpawn("spawn");
    const opened = await openInBrowser(link, { platform: "linux", spawn: ok.spawn, tmpDir: base });
    expect(opened.result).toBe("opened");
    expect(ok.calls[0]).toMatchObject({
      command: "xdg-open",
      options: { shell: false, stdio: "ignore", detached: true },
    });
    expect(ok.unrefs()).toBe(1);
    await opened.close();

    // A failed start leaves no launcher page behind.
    const missing = fakeSpawn("error");
    const notFound = await openInBrowser(link, {
      platform: "linux",
      spawn: missing.spawn,
      tmpDir: base,
    });
    expect(notFound.result).toBe("failed");
    expect(readdirSync(base)).toEqual([]);
    const throwing = fakeSpawn("throw");
    expect(
      (await openInBrowser(link, { platform: "darwin", spawn: throwing.spawn, tmpDir: base }))
        .result,
    ).toBe("failed");
    expect(readdirSync(base)).toEqual([]);

    // A link the CLI did not make, or a page that cannot be written: nothing is started.
    const refused = fakeSpawn("spawn");
    expect(
      (await openInBrowser("https://example.com/", { platform: "linux", spawn: refused.spawn }))
        .result,
    ).toBe("failed");
    expect(
      (
        await openInBrowser(link, {
          platform: "linux",
          spawn: refused.spawn,
          tmpDir: join(base, "missing"),
        })
      ).result,
    ).toBe("failed");
    expect(refused.calls).toHaveLength(0);
    await expect(notFound.close()).resolves.toBeUndefined();
  });
});
