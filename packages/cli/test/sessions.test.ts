import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  validateReplay,
  validateReplayModel,
  withoutReplyDetails,
  type SessionSummary,
} from "@orbitrace/core";
import type { SessionReplayer } from "@orbitrace/core/node";
import { CliError } from "../src/errors.js";
import {
  CLI_ADAPTERS,
  MIN_KEY_PREFIX,
  chooseSession,
  createReplayer,
  matchSessionKeys,
  resolveContext,
  resolveRoots,
  toUserRoot,
  type HostContext,
} from "../src/sessions.js";
import { makeFakeMachine, removeTempDirs, type FakeMachine } from "./helpers.js";

let machine: FakeMachine;
let host: HostContext;

beforeAll(() => {
  machine = makeFakeMachine();
  host = { platform: process.platform, homeDir: machine.home, env: {}, cwd: machine.root };
});

afterAll(() => {
  removeTempDirs();
});

describe("toUserRoot", () => {
  it("resolves a relative path against the working folder and keeps the rest", () => {
    const cwd = resolve("/", "work");
    expect(toUserRoot("conf", cwd)).toBe(resolve(cwd, "conf"));
    expect(toUserRoot(" conf ", cwd)).toBe(resolve(cwd, "conf"));
    expect(toUserRoot("~/conf", cwd)).toBe("~/conf");
    const absolute = resolve("/", "elsewhere", "conf");
    expect(toUserRoot(absolute, cwd)).toBe(absolute);
  });
});

describe("resolveContext", () => {
  it("builds core's context from the host and the flags", () => {
    expect(resolveContext(host, { configDirs: ["fixtures/config"], extraRoots: true })).toEqual({
      platform: host.platform,
      homeDir: machine.home,
      env: {},
      userRoots: [resolve(machine.root, "fixtures/config")],
      includeExtraRoots: true,
    });
  });
});

describe("resolveRoots", () => {
  it("puts a --config-dir folder first, as core orders roots", async () => {
    const { roots, warnings } = await resolveRoots(host, {
      configDirs: [machine.configDir],
      extraRoots: false,
    });
    expect(warnings).toEqual([]);
    expect(roots[0]).toMatchObject({ resolvedBy: "user-setting", available: true });
    expect(roots.map((root) => root.resolvedBy)).toContain("os-default");
  });

  it("warns once for each --config-dir folder that is missing, naming it as typed", async () => {
    const { warnings } = await resolveRoots(host, {
      configDirs: ["missing-one", machine.configDir, join("missing", "two")],
      extraRoots: false,
    });
    expect(warnings.map((warning) => warning.code)).toEqual([
      "config-dir-unavailable",
      "config-dir-unavailable",
    ]);
    expect(warnings[0]?.message).toMatch(/missing-one$/);
    expect(warnings[1]?.message).toMatch(/two$/);
    for (const warning of warnings) expect(warning.message).not.toContain(machine.root);
  });

  it("uses the Claude Code adapter", () => {
    expect(CLI_ADAPTERS.map((adapter) => adapter.runtime)).toEqual(["claude-code"]);
  });
});

describe("createReplayer", () => {
  it("lists and loads the sessions under the given roots", async () => {
    const { roots } = await resolveRoots(host, {
      configDirs: [machine.configDir],
      extraRoots: false,
    });
    const replayer = createReplayer(roots);
    const sessions = await replayer.list();
    expect(sessions.length).toBeGreaterThan(1);
    const loaded = await replayer.load(sessions[0]?.key as string);
    expect(validateReplayModel(loaded)).toBe(true);
    expect(validateReplay(withoutReplyDetails(loaded))).toBe(true);
  });
});

describe("matchSessionKeys", () => {
  const keys = [
    "claude-code:abcd1111000000000000000000000000",
    "claude-code:abcd2222000000000000000000000000",
    "claude-code:ffff0000000000000000000000000000",
  ];

  it("matches a whole key exactly", () => {
    expect(matchSessionKeys(keys, keys[2] as string)).toEqual([keys[2]]);
    expect(matchSessionKeys(keys, ` ${keys[2] as string} `)).toEqual([keys[2]]);
  });

  it("matches a start of the key, with or without the runtime", () => {
    expect(matchSessionKeys(keys, "ffff")).toEqual([keys[2]]);
    expect(matchSessionKeys(keys, "claude-code:ffff")).toEqual([keys[2]]);
    expect(matchSessionKeys(keys, "abcd1")).toEqual([keys[0]]);
    expect(matchSessionKeys(keys, "abcd")).toEqual([keys[0], keys[1]]);
  });

  it(`needs at least ${MIN_KEY_PREFIX} characters after the runtime`, () => {
    expect(matchSessionKeys(keys, "fff")).toEqual([]);
    expect(matchSessionKeys(keys, "claude-code:fff")).toEqual([]);
    expect(matchSessionKeys(keys, "claude-code:")).toEqual([]);
    expect(matchSessionKeys(keys, "")).toEqual([]);
  });

  it("does not match the middle of a key", () => {
    expect(matchSessionKeys(keys, "1111")).toEqual([]);
  });
});

/** A replayer that lists fixed summaries. Only `list` is used by chooseSession. */
function fakeReplayer(keys: readonly string[]): SessionReplayer {
  const sessions: SessionSummary[] = keys.map((key, index) => ({
    key,
    runtime: "claude-code",
    projectLabel: "example-project",
    sessionId: `session-${index}`,
    lastActivity: 1000 - index,
    live: "unknown",
    subagentCount: 0,
  }));
  return {
    list: async (options) => sessions.slice(0, options?.limit ?? sessions.length),
    find: async () => {
      throw new Error("not used");
    },
    load: async () => {
      throw new Error("not used");
    },
    follow: () => () => undefined,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as CliError).code;
  }
  throw new Error("expected a CliError");
}

describe("chooseSession", () => {
  const keys = ["claude-code:aaaa1111", "claude-code:aaaa2222", "claude-code:bbbb0000"];

  it("takes the newest session for --latest", async () => {
    expect(await chooseSession(fakeReplayer(keys), { latest: true })).toBe(keys[0]);
  });

  it("finds a key or a unique start of one", async () => {
    expect(await chooseSession(fakeReplayer(keys), { key: keys[1] as string })).toBe(keys[1]);
    expect(await chooseSession(fakeReplayer(keys), { key: "bbbb" })).toBe(keys[2]);
  });

  it("fails with no-sessions, not-found and ambiguous", async () => {
    expect(await codeOf(chooseSession(fakeReplayer([]), { latest: true }))).toBe("no-sessions");
    expect(await codeOf(chooseSession(fakeReplayer(keys), { key: "cccc" }))).toBe("not-found");
    expect(await codeOf(chooseSession(fakeReplayer(keys), { key: "aaaa" }))).toBe("ambiguous");
  });
});
