/**
 * Opening a file in the public player: the size limit first, then the app's own loader
 * (`load-file.ts`), which checks a replay with `validateReplay` and lists the reasons it fails
 * with `describeReplayProblems`. The file is read in the page and never sent anywhere.
 */

import { loadFile, type FileLoadError, type FileLoadResult } from "../load-file";
import { PLAYER_MESSAGES } from "./messages";

/** The largest file or linked replay the player reads: 50 MB (52,428,800 bytes). */
export const MAX_REPLAY_BYTES = 50 * 1024 * 1024;

const MEGABYTE = 1024 * 1024;

/** A byte count for messages: whole megabytes when exact, otherwise one decimal ("72.4 MB"). */
export function formatMegabytes(bytes: number): string {
  const value = bytes / MEGABYTE;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

/** The limit as the start screen and the messages say it. */
export const MAX_REPLAY_SIZE_TEXT = formatMegabytes(MAX_REPLAY_BYTES);

/** Why a file of `size` bytes is refused, or `null` when it is within `limit`. */
export function sizeProblem(size: number, limit: number = MAX_REPLAY_BYTES): FileLoadError | null {
  if (size <= limit) return null;
  return {
    title: PLAYER_MESSAGES.tooLarge(formatMegabytes(size), formatMegabytes(limit)),
    problems: [],
  };
}

/**
 * Check a picked or dropped file's size, then load it. A file over the limit is refused before
 * any of it is read.
 */
export async function openPlayerFile(
  file: Pick<File, "name" | "size" | "text">,
  limit: number = MAX_REPLAY_BYTES,
): Promise<FileLoadResult> {
  const tooLarge = sizeProblem(file.size, limit);
  if (tooLarge !== null) return { ok: false, error: tooLarge };
  return loadFile(file);
}

/** The header label for an opened file: `Replay file: <name>` or `Transcript: <name> (...)`. */
export function fileLabel(kind: "replay" | "transcript", name: string): string {
  return kind === "replay"
    ? `Replay file: ${name}`
    : `Transcript: ${name} (${PLAYER_MESSAGES.transcriptNote})`;
}
