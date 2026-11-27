/** Text formatting for the terminal and writing the export file. */

import { statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionSummary } from "@orbitrace/core";
import { CliError } from "./errors.js";

/**
 * Replace control characters with `?`. A project label comes from a folder name on disk, and an
 * escape sequence in it must not reach the terminal as a command.
 */
export function sanitizeForTerminal(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `YYYY-MM-DD HH:MM` in the local time zone, or `-` for a time that is not a valid date. */
export function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "-";
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

const LIST_HEADERS = ["KEY", "LAST ACTIVITY", "LIVE", "SUBAGENTS", "PROJECT"] as const;
const LIST_HEADERS_WITH_SOURCE = [
  "KEY",
  "LAST ACTIVITY",
  "LIVE",
  "SUBAGENTS",
  "SOURCE",
  "PROJECT",
] as const;

/**
 * One row of `orbitrace list`: a session summary, with `history: true` when only the history
 * store holds the session (its transcript was not found under the folders searched, #195).
 */
export type ListedSession = SessionSummary & { readonly history?: true };

/**
 * The session list as an aligned table, one row per session, with a header row. When a session
 * comes from the history store, a SOURCE column says `history` for it and `files` for the others;
 * without one the table is as before.
 */
export function formatSessionTable(sessions: readonly ListedSession[]): string {
  const withSource = sessions.some((session) => session.history === true);
  const headers = withSource ? LIST_HEADERS_WITH_SOURCE : LIST_HEADERS;
  const rows: string[][] = [
    [...headers],
    ...sessions.map((session) => [
      session.key,
      formatLocalTime(session.lastActivity),
      session.live,
      session.subagentCount === null ? "-" : String(session.subagentCount),
      ...(withSource ? [session.history === true ? "history" : "files"] : []),
      sanitizeForTerminal(session.projectLabel),
    ]),
  ];
  const widths = headers.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] as string).length)),
  );
  const lines = rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths[column] as number),
      )
      .join("  ")
      .trimEnd(),
  );
  return `${lines.join("\n")}\n`;
}

export interface WrittenFile {
  /** The path as the user typed it, with the file name added when they named a folder. */
  readonly shown: string;
  readonly bytes: number;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Write `data` to the file the user named. A folder gets `fileName` inside it. Without `force`
 * the file is created only if it does not exist (checked by the open call itself, so nothing is
 * replaced between a check and the write). Every message shows the path as the user typed it,
 * never the resolved absolute path, and never the text of the system error.
 */
export function writeOutputFile(options: {
  readonly target: string;
  readonly cwd: string;
  readonly fileName: string;
  readonly data: string;
  readonly force: boolean;
}): WrittenFile {
  const { target, cwd, fileName, data, force } = options;
  let absolute = resolve(cwd, target);
  let shown = target;
  if (isDirectory(absolute)) {
    absolute = join(absolute, fileName);
    shown = join(target, fileName);
  }
  try {
    writeFileSync(absolute, data, { encoding: "utf8", flag: force ? "w" : "wx" });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      throw new CliError(
        "output-exists",
        `The file ${shown} exists already.`,
        "Add --force to replace it, or choose another file with -o.",
      );
    }
    throw new CliError(
      "output-unwritable",
      `The file ${shown} could not be written.`,
      code === "ENOENT" || code === "ENOTDIR"
        ? "Check that its folder exists."
        : code === "EISDIR"
          ? "That path is a folder."
          : "Check that you can write to that folder.",
    );
  }
  return { shown, bytes: Buffer.byteLength(data, "utf8") };
}
