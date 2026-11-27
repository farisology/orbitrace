/**
 * #211: the history commands with the editor UI replaced by recording fakes. Temporary folders
 * only; a stand-in worker for the commands that need no store, and the extension's own built
 * worker for those that do (skipped, with the reason, where `node:sqlite` is missing). The
 * unavailable path (VS Code 1.96 to 1.100) is checked on every Node with a capability stand-in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeCodeAdapter,
  historyCapability,
  runHistoryIngestWorker,
  withoutSqliteWarning,
  type HistoryCapability,
  type HistorySessionSummary,
} from "@orbitrace/core/node";
import { FIXTURE_CONFIG_DIR } from "@orbitrace/fixtures";
import { createExtensionHistory, type ExtensionHistoryOptions } from "../src/history.js";
import {
  createHistoryCommandHandlers,
  engineText,
  HISTORY_BUTTONS,
  HISTORY_COMMANDS,
  HISTORY_MESSAGES,
  storedSessionItems,
  storePlaceText,
  turnOnDetail,
  unavailableMessage,
  type ModalQuestion,
  type StoredSessionItem,
} from "../src/history-commands.js";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

const probe = await withoutSqliteWarning(historyCapability);
const SKIP_NOTE = probe.available ? "" : ` (skipped: ${probe.reason})`;
const WORKER = pathToFileURL(
  join(fileURLToPath(new URL("..", import.meta.url)), "dist", "history-worker.js"),
);
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const UNAVAILABLE: HistoryCapability = {
  available: false,
  engine: "node:sqlite",
  nodeVersion: "v20.18.1",
  reason: "This Node.js (v20.18.1) has no node:sqlite module. History needs Node 22.13 or later.",
};

/**
 * A capability stand-in that says the store can run. The recording-off tests never open a
 * database, so with this they check the commands' own text on every Node, including Node 20,
 * which has no node:sqlite (#227).
 */
const AVAILABLE: HistoryCapability = {
  available: true,
  engine: "node:sqlite",
  nodeVersion: "v24.22.1",
  sqliteVersion: "3.53.4",
  fts5: true,
};
const available = { capability: async () => AVAILABLE };

interface Ui {
  questions: ModalQuestion[];
  picks: (readonly StoredSessionItem[])[];
  infos: { message: string; buttons: string[] }[];
  warnings: string[];
  errors: string[];
  copied: string[];
  refreshes: number;
  /** Answers: whether a modal question is confirmed, which row is picked, which button. */
  confirm: boolean;
  pick: (items: readonly StoredSessionItem[]) => StoredSessionItem | undefined;
  button: (message: string, buttons: string[]) => string | undefined;
}

function setup(extra: Partial<ExtensionHistoryOptions> = {}, remoteName?: string) {
  const base = makeTempDir();
  const home = join(base, "home");
  const config = join(base, "config");
  // Inside the home folder, so the commands show it as `~/...`.
  const data = join(home, "orbitrace-data");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: config,
    ORBITRACE_DATA_DIR: data,
  };
  const fixtureRoot = {
    runtime: "claude-code" as const,
    root: FIXTURE_CONFIG_DIR,
    resolvedBy: "user-setting" as const,
    available: true,
  };
  const history = createExtensionHistory({
    env,
    homeDir: home,
    workerUrl: WORKER,
    listFileSessions: () => claudeCodeAdapter.listSessions(fixtureRoot),
    findSession: async () => null,
    runWorker: probe.available ? runHistoryIngestWorker : async () => Promise.reject(new Error()),
    ...extra,
  });
  const ui: Ui = {
    questions: [],
    picks: [],
    infos: [],
    warnings: [],
    errors: [],
    copied: [],
    refreshes: 0,
    confirm: true,
    pick: (items) => items[0],
    button: () => undefined,
  };
  const handlers = createHistoryCommandHandlers({
    history,
    ask: async (question) => {
      ui.questions.push(question);
      return ui.confirm;
    },
    pickSession: async (items) => {
      ui.picks.push(items);
      return ui.pick(items);
    },
    showInfo: async (message, ...buttons) => {
      ui.infos.push({ message, buttons });
      return ui.button(message, buttons);
    },
    showWarning: (message) => ui.warnings.push(message),
    showError: (message) => ui.errors.push(message),
    copyText: async (text) => {
      ui.copied.push(text);
    },
    refreshSessions: () => {
      ui.refreshes += 1;
    },
    now: () => NOW,
    ...(remoteName === undefined ? {} : { remoteName }),
  });
  return { base, home, data, history, handlers, ui, settings: join(data, "settings.json") };
}

describe("the command ids and texts", () => {
  it("name six commands under orbitrace.history", () => {
    expect(Object.values(HISTORY_COMMANDS)).toEqual([
      "orbitrace.history.turnOn",
      "orbitrace.history.turnOff",
      "orbitrace.history.status",
      "orbitrace.history.deleteSession",
      "orbitrace.history.deleteAll",
      "orbitrace.history.showLocation",
    ]);
  });

  it("say what is stored, where, and that redaction is best effort before turning on", () => {
    const detail = turnOnDetail("~/.orbitrace");
    expect(detail).toContain("~/.orbitrace");
    expect(detail).toContain("prompts");
    expect(detail).toMatch(/redaction is best effort/);
    expect(detail).toMatch(/never uploaded/);
    expect(detail).toContain("orbitrace open");
  });

  it("say the copy stays on this computer in a local window", () => {
    const detail = turnOnDetail("~/.orbitrace");
    expect(detail).toContain("sessions in ~/.orbitrace, so they outlive");
    expect(detail).toContain(
      "The copy stays on this computer, readable by your account only, and is never uploaded.",
    );
    expect(detail).not.toMatch(/remote/);
    expect(storePlaceText("~/.orbitrace")).toBe("~/.orbitrace");
    expect(storePlaceText("~/.orbitrace", "")).toBe("~/.orbitrace");
  });

  it("say the copy goes to the remote machine in a window connected to one", () => {
    const detail = turnOnDetail("~/.orbitrace", "ssh-remote");
    expect(detail).toContain(
      "sessions in ~/.orbitrace on the remote machine this window is connected to (ssh-remote), not on this computer, so they outlive",
    );
    expect(detail).toContain(
      "The copy stays on that machine, readable by your account there only, and is never uploaded.",
    );
    expect(detail).not.toContain("stays on this computer");
    expect(detail).toMatch(/redaction is best effort/);
  });

  it("explain an unavailable store with the reason and a way out", () => {
    const text = unavailableMessage(UNAVAILABLE.reason);
    expect(text).toContain(UNAVAILABLE.reason);
    expect(text).toContain("VS Code 1.101");
    expect(text).toContain("orbitrace history disable");
    expect(engineText(UNAVAILABLE)).toContain("unavailable");
    expect(
      engineText({
        available: true,
        engine: "node:sqlite",
        nodeVersion: "v24.0.0",
        sqliteVersion: "3.50.0",
        fts5: true,
      }),
    ).toBe("node:sqlite, SQLite 3.50.0, Node v24.0.0");
  });

  it("make quick pick rows from stored sessions without paths or ids", () => {
    const session: HistorySessionSummary = {
      key: "claude-code:example",
      runtime: "claude-code",
      sessionId: "00000000-0000-4000-8000-000000000001",
      projectLabel: "kite-workshop",
      lastActivity: NOW - 5 * 60_000,
      firstIngestedAt: NOW,
      lastIngestedAt: NOW,
      subagentCount: 2,
      lineCount: 1,
    };
    expect(
      storedSessionItems([session, { ...session, subagentCount: 0, projectLabel: " " }], NOW),
    ).toEqual([
      { label: "kite-workshop", description: "5 min ago · 1 line · 2 subagents", key: session.key },
      { label: "(unnamed project)", description: "5 min ago · 1 line", key: session.key },
    ]);
  });
});

describe("where the store cannot run (VS Code 1.96 to 1.100)", () => {
  it("every command explains why and nothing else changes", async () => {
    const { data, home, handlers, ui } = setup({ capability: async () => UNAVAILABLE });
    for (const run of Object.values(handlers)) await run();
    expect(ui.errors).toHaveLength(6);
    for (const error of ui.errors) expect(error).toBe(unavailableMessage(UNAVAILABLE.reason));
    expect(ui.questions).toEqual([]);
    expect(ui.infos).toEqual([]);
    expect(ui.refreshes).toBe(0);
    expect(existsSync(data)).toBe(false);
    expect(existsSync(join(home, ".orbitrace"))).toBe(false);
  });
});

describe("the commands with recording off", () => {
  it("Turn off, status and show location create nothing", async () => {
    const { data, handlers, ui } = setup(available);
    await handlers.turnOff();
    await handlers.status();
    await handlers.showLocation();
    await handlers.deleteSession();
    await handlers.deleteAll();
    expect(ui.infos.map((info) => info.message)).toEqual([
      HISTORY_MESSAGES.alreadyOff,
      expect.stringMatching(/^History recording is off\. Engine: .*Nothing is stored yet\.$/),
      expect.stringMatching(/There is no store there yet\.$/),
      HISTORY_MESSAGES.nothingStored,
      HISTORY_MESSAGES.noStore,
    ]);
    expect(ui.infos[1]?.buttons).toEqual([HISTORY_BUTTONS.turnOn]);
    expect(ui.infos[2]?.message).toContain(`~${sep}orbitrace-data`);
    expect(existsSync(data)).toBe(false);
  });

  it("Turn on asks first; declining writes nothing", async () => {
    const { data, handlers, ui } = setup(available);
    ui.confirm = false;
    await handlers.turnOn();
    expect(ui.questions).toHaveLength(1);
    expect(ui.questions[0]).toMatchObject({
      message: HISTORY_MESSAGES.turnOnQuestion,
      confirm: HISTORY_BUTTONS.turnOn,
    });
    expect(ui.questions[0]?.detail).toContain("redaction is best effort");
    expect(existsSync(data)).toBe(false);
  });

  it("name the remote machine in status and show location in a remote window", async () => {
    const { data, handlers, ui } = setup(available, "wsl");
    ui.confirm = false;
    await handlers.turnOn();
    await handlers.status();
    await handlers.showLocation();
    const remote = "on the remote machine this window is connected to (wsl), not on this computer";
    expect(ui.questions[0]?.detail).toContain(`orbitrace-data ${remote}, so they outlive`);
    expect(ui.questions[0]?.detail).toContain("The copy stays on that machine");
    expect(ui.infos[0]?.message).toContain(`orbitrace-data ${remote}. Nothing is stored yet.`);
    expect(ui.infos[1]?.message).toContain(
      `orbitrace-data ${remote}. There is no store there yet.`,
    );
    expect(existsSync(data)).toBe(false);
  });

  it("Show where it is stored copies the full path when asked", async () => {
    const { data, handlers, ui } = setup(available);
    ui.button = () => HISTORY_BUTTONS.copyPath;
    await handlers.showLocation();
    expect(ui.copied).toEqual([data]);
  });

  it("says why when there is no usable data folder", async () => {
    const { handlers, ui } = setup({ ...available, env: { ORBITRACE_DATA_DIR: "relative" } });
    await handlers.status();
    expect(ui.errors[0]).toMatch(/^The history folder could not be worked out: .*absolute path/);
  });

  it("shows a failure with core's fixed text", async () => {
    const { data, handlers, ui } = setup(available);
    // A file where the data folder should be: the settings file cannot be written.
    writeFileSync(data, "");
    await handlers.turnOn();
    expect(ui.errors).toEqual(["History: The history folder could not be created."]);
  });
});

describe(`the commands with a store${SKIP_NOTE}`, () => {
  it.skipIf(!probe.available)(
    "turn on (ingest in the worker), status, delete one, turn off, delete all",
    async () => {
      const { data, history, handlers, ui, settings } = setup();
      // Status offers to turn recording on, which asks first.
      ui.button = (_message, buttons) => buttons[0];
      await handlers.status();
      expect(readFileSync(settings, "utf8")).toBe('{"settings":1,"historyRecording":true}\n');
      expect(ui.questions.map((q) => q.message)).toEqual([HISTORY_MESSAGES.turnOnQuestion]);
      expect(ui.infos.at(-1)?.message).toMatch(
        /^History recording is on\. Sessions are copied into ~/,
      );
      expect(ui.refreshes).toBe(1);
      await history.idle();
      expect(history.storeExists()).toBe(true);

      ui.button = () => undefined;
      await handlers.turnOn();
      expect(ui.infos.at(-1)?.message).toBe(HISTORY_MESSAGES.alreadyOn);

      await handlers.status();
      expect(ui.infos.at(-1)?.message).toMatch(
        /^History recording is on\..*Stored: \d+ sessions, /,
      );
      expect(ui.infos.at(-1)?.buttons).toEqual([HISTORY_BUTTONS.turnOff]);

      const before = await history.listStored();
      let picked: StoredSessionItem | undefined;
      ui.pick = (items) => (picked = items[1]);
      await handlers.deleteSession();
      expect(ui.questions.at(-1)).toMatchObject({
        message: HISTORY_MESSAGES.deleteOneQuestion,
        confirm: HISTORY_BUTTONS.delete,
      });
      expect(ui.infos.at(-1)?.message).toBe(HISTORY_MESSAGES.deletedOne);
      const after = await history.listStored();
      expect(after).toHaveLength(before.length - 1);
      expect(after.map((s) => s.key)).not.toContain(picked?.key);

      // Declining the delete changes nothing.
      ui.confirm = false;
      await handlers.deleteSession();
      await handlers.deleteAll();
      expect(await history.listStored()).toHaveLength(after.length);
      ui.confirm = true;

      await handlers.turnOff();
      expect(ui.infos.at(-1)?.message).toBe(
        `${HISTORY_MESSAGES.turnedOff} ${HISTORY_MESSAGES.storedStays}`,
      );
      expect(readFileSync(settings, "utf8")).toBe('{"settings":1,"historyRecording":false}\n');

      await handlers.deleteAll();
      expect(ui.questions.at(-1)?.message).toBe(HISTORY_MESSAGES.deleteAllQuestion);
      expect(ui.questions.at(-1)?.detail).toContain(`(${after.length} sessions)`);
      expect(ui.infos.at(-1)?.message).toBe(
        `Deleted the history store (${after.length} sessions).`,
      );
      expect(history.storeExists()).toBe(false);
      // Only the settings file is left in the data folder.
      expect(existsSync(join(data, "history.sqlite"))).toBe(false);
      expect(existsSync(settings)).toBe(true);
      expect(ui.errors).toEqual([]);
      await history.stop();
    },
  );

  it.skipIf(!probe.available)(
    "the turn-on confirmation names the remote machine in a remote window",
    async () => {
      const { history, handlers, ui } = setup({}, "dev-container");
      await handlers.turnOn();
      expect(ui.infos.at(-1)?.message).toMatch(
        /^History recording is on\. Sessions are copied into ~.* on the remote machine this window is connected to \(dev-container\), not on this computer in the background/,
      );
      await history.idle();
      await history.stop();
    },
  );

  it.skipIf(!probe.available)("Delete all says that recording stays on when it is on", async () => {
    const { history, handlers, ui } = setup();
    await history.setRecording(true);
    await history.idle();
    await history.stop();
    await handlers.deleteAll();
    expect(ui.questions.at(-1)?.detail).toContain("Recording stays on");
  });
});
