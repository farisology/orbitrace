/**
 * The history commands (#211): turn recording on, turn it off, show status, delete one session,
 * delete all history, show where it is stored. Every one is in the Command Palette under the
 * Orbitrace category. The editor UI (modal dialogs, quick pick, notifications, clipboard) is
 * passed in, so this module has no vscode dependency and is unit tested; `extension.ts` wires it
 * to the real API.
 *
 * - Each command first checks `historyCapability()`. Where the store cannot run (VS Code 1.96 to
 *   1.100, whose Node has no `node:sqlite`) it explains why and changes nothing.
 * - Turning recording on asks first, in a modal dialog that says what is stored, where, and that
 *   redaction of secrets is best effort. Deleting one session and deleting all history ask first
 *   in a modal dialog too.
 * - The switch is the settings file both hosts share; `orbitrace history status` and these
 *   commands always agree.
 *
 * Paths are shown to the user (with the home folder as `~`) and nowhere else.
 */

import { formatAgo } from "@orbitrace/core";
import {
  formatHistoryBytes,
  toHistoryErrorInfo,
  type HistoryCapability,
  type HistorySessionSummary,
} from "@orbitrace/core/node";
import { showLocalPath, type ExtensionHistory } from "./history.js";
import { projectText } from "./session-labels.js";

/** Command ids, as in package.json `contributes.commands`. */
export const HISTORY_COMMANDS = {
  turnOn: "orbitrace.history.turnOn",
  turnOff: "orbitrace.history.turnOff",
  status: "orbitrace.history.status",
  deleteSession: "orbitrace.history.deleteSession",
  deleteAll: "orbitrace.history.deleteAll",
  showLocation: "orbitrace.history.showLocation",
} as const;

/** Button labels. */
export const HISTORY_BUTTONS = {
  turnOn: "Turn on",
  turnOff: "Turn off",
  delete: "Delete",
  deleteAll: "Delete all",
  copyPath: "Copy path",
} as const;

/** Fixed texts. No path, key or session id. */
export const HISTORY_MESSAGES = {
  unavailable: "History is not available in this editor:",
  unavailableHint:
    "It needs VS Code 1.101 or later; the rest of Orbitrace works as before. To turn recording off or delete the store from here, use 'orbitrace history disable' or 'orbitrace history delete --all' in a terminal.",
  noPlace: "The history folder could not be worked out:",
  alreadyOn: "History recording is already on.",
  alreadyOff: "History recording is already off.",
  turnOnQuestion: "Turn history recording on?",
  turnedOff: "History recording is off.",
  storedStays:
    "What is stored stays; delete it with 'Orbitrace: Delete all history' or one session with 'Orbitrace: Delete a session from history...'.",
  nothingStored: "There are no sessions in the history store.",
  pickTitle: "Orbitrace: Delete a session from history",
  pickPlaceholder: "Choose the stored session to delete",
  deleteOneQuestion: "Delete the stored copy of this session?",
  deletedOne: "Deleted the session from the history store.",
  notScrubbed:
    "Another program had the store open, so old copies of the deleted lines stay in the store's WAL file until it closes it.",
  sessionGone: "That session is no longer in the history store.",
  noStore: "There is no history store to delete.",
  deleteAllQuestion: "Delete all history?",
  failed: "History:",
} as const;

/** One row of the delete quick pick. */
export interface StoredSessionItem {
  readonly label: string;
  readonly description: string;
  readonly key: string;
}

/** A modal question: the message, a detail paragraph and the one button that goes ahead. */
export interface ModalQuestion {
  readonly message: string;
  readonly detail: string;
  readonly confirm: string;
}

export interface HistoryCommandDeps {
  readonly history: ExtensionHistory;
  /** Ask in a modal dialog. Resolves true only when the user chose `confirm`. */
  ask(question: ModalQuestion): Promise<boolean>;
  /** Let the user pick one stored session. Resolves undefined when dismissed. */
  pickSession(items: readonly StoredSessionItem[]): Promise<StoredSessionItem | undefined>;
  /** A notification with optional buttons; resolves the button chosen. */
  showInfo(message: string, ...buttons: string[]): Promise<string | undefined>;
  showWarning(message: string): void;
  showError(message: string): void;
  /** Put text on the clipboard. */
  copyText(text: string): Promise<void>;
  /** The Sessions view lists again. */
  refreshSessions(): void;
  /** Clock, for tests. Default `Date.now`. */
  now?(): number;
  /**
   * The remote this window is connected to (`vscode.env.remoteName`: `ssh-remote`, `wsl`,
   * `dev-container`, ...), or undefined for a local window. The extension host runs on the
   * workspace side, so over a remote the store is on that machine, and every text that says
   * where it is says so.
   */
  readonly remoteName?: string;
}

export interface HistoryCommandHandlers {
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  status(): Promise<void>;
  deleteSession(): Promise<void>;
  deleteAll(): Promise<void>;
  showLocation(): Promise<void>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The message shown by every command where the store cannot run. */
export function unavailableMessage(reason: string): string {
  return `${HISTORY_MESSAGES.unavailable} ${reason} ${HISTORY_MESSAGES.unavailableHint}`;
}

/** The engine, for the status line. */
export function engineText(capability: HistoryCapability): string {
  return capability.available
    ? `node:sqlite, SQLite ${capability.sqliteVersion}, Node ${capability.nodeVersion}`
    : `unavailable (${capability.reason})`;
}

/**
 * Where the store is, for every text that says so: the folder as shown and, in a window
 * connected to a remote, that the folder is on the remote machine and not on this computer.
 */
export function storePlaceText(shownDir: string, remoteName?: string): string {
  return remoteName === undefined || remoteName === ""
    ? shownDir
    : `${shownDir} on the remote machine this window is connected to (${remoteName}), not on this computer`;
}

/** The detail of the Turn on dialog: what is stored, where, and that redaction is best effort. */
export function turnOnDetail(shownDir: string, remoteName?: string): string {
  const remote = remoteName !== undefined && remoteName !== "";
  return [
    `Orbitrace will keep a copy of your Claude Code sessions in ${storePlaceText(shownDir, remoteName)}, so they outlive Claude Code's cleanup.`,
    "The copy holds what the transcripts hold: your prompts, the replies, tool inputs and outputs, file paths and project names.",
    "Secrets in known formats are redacted before they are written, but redaction is best effort: a secret in an unknown format is kept.",
    remote
      ? "The copy stays on that machine, readable by your account there only, and is never uploaded."
      : "The copy stays on this computer, readable by your account only, and is never uploaded.",
    "While recording is on, this editor copies sessions in the background, and so does 'orbitrace open'; one switch covers both. Turn it off or delete the copy at any time.",
  ].join("\n\n");
}

/** The quick pick rows for the stored sessions, newest first. */
export function storedSessionItems(
  sessions: readonly HistorySessionSummary[],
  now: number,
): StoredSessionItem[] {
  return sessions.map((session) => ({
    label: projectText(session),
    description: [
      formatAgo(session.lastActivity, now),
      plural(session.lineCount, "line", "lines"),
      ...(session.subagentCount > 0
        ? [plural(session.subagentCount, "subagent", "subagents")]
        : []),
    ].join(" · "),
    key: session.key,
  }));
}

/** The message of a failure: core's fixed text for a store error, never a path. */
function failureMessage(error: unknown): string {
  return `${HISTORY_MESSAGES.failed} ${toHistoryErrorInfo(error).message}`;
}

export function createHistoryCommandHandlers(deps: HistoryCommandDeps): HistoryCommandHandlers {
  const { history } = deps;
  const shown = (path: string): string => showLocalPath(path, history.homeDir, history.platform);
  const { remoteName } = deps;
  /** The folder as shown, with the remote machine named when the window is connected to one. */
  const place = (path: string): string => storePlaceText(shown(path), remoteName);

  /** Whether history can run here; explains why not and resolves false otherwise. */
  async function ready(): Promise<boolean> {
    const capability = await history.capability();
    if (!capability.available) {
      deps.showError(unavailableMessage(capability.reason));
      return false;
    }
    const found = history.location();
    if (found.location === null) {
      deps.showError(`${HISTORY_MESSAGES.noPlace} ${found.reason}`);
      return false;
    }
    return true;
  }

  /** Run a command body; a failure is shown with core's fixed message. */
  async function guarded(body: () => Promise<void>): Promise<void> {
    try {
      if (!(await ready())) return;
      await body();
    } catch (error) {
      deps.showError(failureMessage(error));
    }
  }

  const dirShown = (): string => {
    const found = history.location();
    return found.location === null ? "" : shown(found.location.dir);
  };
  const placeShown = (): string => storePlaceText(dirShown(), remoteName);

  const handlers: HistoryCommandHandlers = {
    turnOn: () =>
      guarded(async () => {
        if (history.settings().recording) {
          await history.sync();
          await deps.showInfo(HISTORY_MESSAGES.alreadyOn);
          return;
        }
        const yes = await deps.ask({
          message: HISTORY_MESSAGES.turnOnQuestion,
          detail: turnOnDetail(dirShown(), remoteName),
          confirm: HISTORY_BUTTONS.turnOn,
        });
        if (!yes) return;
        await history.setRecording(true);
        deps.refreshSessions();
        await deps.showInfo(
          `History recording is on. Sessions are copied into ${placeShown()} in the background while the editor runs.`,
        );
      }),

    turnOff: () =>
      guarded(async () => {
        const result = await history.setRecording(false);
        const stored = history.storeExists();
        if (!result.changed && result.before.state !== "invalid") {
          await deps.showInfo(HISTORY_MESSAGES.alreadyOff);
          return;
        }
        await deps.showInfo(
          stored
            ? `${HISTORY_MESSAGES.turnedOff} ${HISTORY_MESSAGES.storedStays}`
            : HISTORY_MESSAGES.turnedOff,
        );
      }),

    status: () =>
      guarded(async () => {
        const status = await history.status();
        const on = status.settings.recording;
        const recording = on
          ? "History recording is on."
          : status.settings.state === "invalid"
            ? "History recording is off (the settings file could not be read)."
            : "History recording is off.";
        const stored = !status.exists
          ? "Nothing is stored yet."
          : status.totals === null
            ? `Stored: unknown${status.error === null ? "" : ` (${status.error})`}.`
            : `Stored: ${plural(status.totals.sessions, "session", "sessions")}, ${formatHistoryBytes(status.bytes)}.`;
        const message = `${recording} Engine: ${engineText(status.capability)}. Where: ${place(status.location.dir)}. ${stored}`;
        const toggle = on ? HISTORY_BUTTONS.turnOff : HISTORY_BUTTONS.turnOn;
        const chosen = await deps.showInfo(message, toggle);
        if (chosen === HISTORY_BUTTONS.turnOn) await handlers.turnOn();
        else if (chosen === HISTORY_BUTTONS.turnOff) await handlers.turnOff();
      }),

    deleteSession: () =>
      guarded(async () => {
        const stored = await history.listStored();
        if (stored.length === 0) {
          await deps.showInfo(HISTORY_MESSAGES.nothingStored);
          return;
        }
        const now = (deps.now ?? Date.now)();
        const chosen = await deps.pickSession(storedSessionItems(stored, now));
        if (chosen === undefined) return;
        const yes = await deps.ask({
          message: HISTORY_MESSAGES.deleteOneQuestion,
          detail: `${chosen.label}, ${chosen.description}. Only the stored copy is deleted; its transcript, if it is still there, is not touched.`,
          confirm: HISTORY_BUTTONS.delete,
        });
        if (!yes) return;
        const result = await history.deleteSession(chosen.key);
        deps.refreshSessions();
        if (!result.deleted) {
          deps.showError(HISTORY_MESSAGES.sessionGone);
          return;
        }
        await deps.showInfo(HISTORY_MESSAGES.deletedOne);
        if (!result.scrubbed) deps.showWarning(HISTORY_MESSAGES.notScrubbed);
      }),

    deleteAll: () =>
      guarded(async () => {
        const status = await history.status();
        if (!status.exists) {
          await deps.showInfo(HISTORY_MESSAGES.noStore);
          return;
        }
        const counted =
          status.totals === null
            ? ""
            : ` (${plural(status.totals.sessions, "session", "sessions")})`;
        const recordingNote = status.settings.recording
          ? " Recording stays on, so sessions are copied into a new store again; turn it off first to stop that."
          : "";
        const yes = await deps.ask({
          message: HISTORY_MESSAGES.deleteAllQuestion,
          detail: `The whole history store${counted} in ${place(status.location.dir)} is deleted. Claude Code's transcripts are not touched.${recordingNote}`,
          confirm: HISTORY_BUTTONS.deleteAll,
        });
        if (!yes) return;
        await history.deleteAll();
        deps.refreshSessions();
        await deps.showInfo(`Deleted the history store${counted}.`);
      }),

    showLocation: () =>
      guarded(async () => {
        const status = await history.status();
        const dir = place(status.location.dir);
        const chosen = await deps.showInfo(
          status.exists
            ? `History is stored in ${dir}.`
            : `History is stored in ${dir}. There is no store there yet.`,
          HISTORY_BUTTONS.copyPath,
        );
        if (chosen === HISTORY_BUTTONS.copyPath) await deps.copyText(status.location.dir);
      }),
  };
  return handlers;
}
