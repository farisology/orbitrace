import { describe, expect, it } from "vitest";
import {
  COMMAND_MESSAGES,
  createCommandHandlers,
  entryFromArgument,
  keyFromArgument,
  type CommandDeps,
  type PanelTarget,
} from "../src/commands.js";
import { createSessionCatalog, type CatalogEntry } from "../src/session-catalog.js";
import { fakeReplayer, makeRef, makeSummary } from "./helpers.js";

const workspaceSession = makeSummary({ key: "claude-code:ws", lastActivity: 1000 });
const otherSession = makeSummary({
  key: "claude-code:other",
  projectLabel: "marble-run",
  lastActivity: 2000,
});
const refs = [
  makeRef(otherSession, "-workspace-marble-run"),
  makeRef(workspaceSession, "-workspace-kite-workshop"),
];

function setup(
  options: { refs?: typeof refs; listError?: unknown; folders?: string[]; openError?: Error } = {},
) {
  const opened: PanelTarget[] = [];
  const infos: string[] = [];
  const errors: string[] = [];
  const chooserCalls: (readonly CatalogEntry[])[] = [];
  let choice: (entries: readonly CatalogEntry[]) => CatalogEntry | undefined = () => undefined;
  const deps: CommandDeps = {
    catalog: createSessionCatalog(
      fakeReplayer(options.refs ?? refs, { listError: options.listError }),
    ),
    workspacePaths: () => options.folders ?? ["/workspace/kite-workshop"],
    open: (target) => {
      if (options.openError !== undefined) throw options.openError;
      opened.push(target);
    },
    chooseSession: async (entries) => {
      chooserCalls.push(entries);
      return choice(entries);
    },
    showInfo: (message) => infos.push(message),
    showError: (message) => errors.push(message),
  };
  return {
    handlers: createCommandHandlers(deps),
    opened,
    infos,
    errors,
    chooserCalls,
    choose: (next: typeof choice) => {
      choice = next;
    },
  };
}

describe("entryFromArgument and keyFromArgument", () => {
  const entry: CatalogEntry = { summary: workspaceSession, inWorkspace: true };

  it("read a Sessions view row and a plain key", () => {
    expect(entryFromArgument({ kind: "session", entry })).toBe(entry);
    expect(keyFromArgument({ kind: "session", entry })).toBe("claude-code:ws");
    expect(keyFromArgument("claude-code:x")).toBe("claude-code:x");
  });

  it("refuse anything else", () => {
    for (const value of [
      undefined,
      null,
      "",
      3,
      {},
      { entry: null },
      { entry: { summary: { key: 1 } } },
    ]) {
      expect(keyFromArgument(value)).toBeNull();
    }
    expect(entryFromArgument("claude-code:x")).toBeNull();
    expect(entryFromArgument({ entry: { summary: { key: "k", projectLabel: "p" } } })).toBeNull();
  });
});

describe("visualiseCurrent", () => {
  it("opens the newest session of the workspace", async () => {
    const { handlers, opened, infos } = setup();
    await handlers.visualiseCurrent();
    expect(opened).toEqual([{ kind: "session", key: "claude-code:ws", summary: workspaceSession }]);
    expect(infos).toEqual([]);
  });

  it("falls back to the most recent session and says so", async () => {
    const { handlers, opened, infos } = setup({ folders: ["/workspace/elsewhere"] });
    await handlers.visualiseCurrent();
    expect(opened).toEqual([{ kind: "session", key: "claude-code:other", summary: otherSession }]);
    expect(infos).toEqual([COMMAND_MESSAGES.notInWorkspace]);
  });

  it("does not mention the workspace when no folder is open", async () => {
    const { handlers, opened, infos } = setup({ folders: [] });
    await handlers.visualiseCurrent();
    expect(opened[0]).toMatchObject({ key: "claude-code:other" });
    expect(infos).toEqual([]);
  });

  it("falls back to the demo with no sessions, and on a listing error", async () => {
    const empty = setup({ refs: [] });
    await empty.handlers.visualiseCurrent();
    expect(empty.opened).toEqual([{ kind: "demo" }]);
    expect(empty.infos).toEqual([COMMAND_MESSAGES.noSessions]);

    const failing = setup({ listError: new Error("x") });
    await failing.handlers.visualiseCurrent();
    expect(failing.opened).toEqual([{ kind: "demo" }]);
    expect(failing.errors).toEqual([COMMAND_MESSAGES.listFailed]);
  });

  it("reports a failure to open the tab", async () => {
    const { handlers, errors } = setup({ openError: new Error("The app is missing.") });
    await handlers.visualiseCurrent();
    expect(errors).toEqual(["The app is missing."]);
    const blank = setup({ openError: new Error("") });
    await blank.handlers.openDemo();
    expect(blank.errors).toEqual([COMMAND_MESSAGES.openFailed]);
  });
});

describe("visualiseSession", () => {
  it("opens a Sessions view row without listing again", async () => {
    const { handlers, opened, chooserCalls } = setup({ listError: new Error("would fail") });
    await handlers.visualiseSession({
      kind: "session",
      entry: { summary: otherSession, inWorkspace: false },
    });
    expect(opened).toEqual([{ kind: "session", key: "claude-code:other", summary: otherSession }]);
    expect(chooserCalls).toEqual([]);
  });

  it("opens a session by key, and reports a key that is gone", async () => {
    const { handlers, opened, errors } = setup();
    await handlers.visualiseSession("claude-code:other");
    expect(opened).toEqual([{ kind: "session", key: "claude-code:other", summary: otherSession }]);
    await handlers.visualiseSession("claude-code:gone");
    expect(errors).toEqual([COMMAND_MESSAGES.sessionGone]);
  });

  it("asks the user, workspace sessions first, and opens the choice", async () => {
    const { handlers, opened, chooserCalls, choose } = setup();
    choose((entries) => entries[1]);
    await handlers.visualiseSession();
    expect(chooserCalls[0]?.map((entry) => entry.summary.key)).toEqual([
      "claude-code:ws",
      "claude-code:other",
    ]);
    expect(opened).toEqual([{ kind: "session", key: "claude-code:other", summary: otherSession }]);
  });

  it("opens nothing when the user dismisses the choice", async () => {
    const { handlers, opened } = setup();
    await handlers.visualiseSession();
    expect(opened).toEqual([]);
  });

  it("shows the demo when there are no sessions or listing fails", async () => {
    const empty = setup({ refs: [] });
    await empty.handlers.visualiseSession();
    expect(empty.opened).toEqual([{ kind: "demo" }]);
    expect(empty.infos).toEqual([COMMAND_MESSAGES.noSessions]);
    const failing = setup({ listError: new Error("x") });
    await failing.handlers.visualiseSession("claude-code:ws");
    expect(failing.opened).toEqual([{ kind: "demo" }]);
    expect(failing.errors).toEqual([COMMAND_MESSAGES.listFailed]);
  });
});

describe("openDemo", () => {
  it("opens the demo", async () => {
    const { handlers, opened } = setup();
    await handlers.openDemo();
    expect(opened).toEqual([{ kind: "demo" }]);
  });
});
