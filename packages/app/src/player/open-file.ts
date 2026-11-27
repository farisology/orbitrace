/**
 * Opening a file in the public player: the file type first, then the size limit, then the app's
 * own loader (`load-file.ts`), which checks a replay with `validateReplay` and lists the reasons
 * it fails with `describeReplayProblems`. The file is read in the page and never sent anywhere.
 *
 * The player opens replay files only (decided on issue 19). A `.jsonl` transcript is refused
 * before any of it is read: a raw transcript holds private content, and a public page must not
 * invite visitors to drop one. The local app (CLI, editor tab, no-host app) still opens
 * transcripts through `loadFile`.
 */

import { droppedKind, loadFile, type FileLoadError, type FileLoadResult } from "../load-file";
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
 * Why the player refuses a file by its name, or `null` for a replay file (`.json`, which
 * includes `.replay.json`). A transcript gets its own message, which says to export a replay.
 */
export function fileTypeProblem(name: string): FileLoadError | null {
  switch (droppedKind(name)) {
    case "replay":
      return null;
    case "transcript":
      return {
        title: PLAYER_MESSAGES.transcriptRefused,
        problems: [PLAYER_MESSAGES.transcriptRefusedHelp],
      };
    default:
      return { title: PLAYER_MESSAGES.unsupported, problems: [] };
  }
}

/**
 * Check a picked or dropped file's type and size, then load it. A transcript, another file type
 * or a file over the limit is refused before any of it is read.
 */
export async function openPlayerFile(
  file: Pick<File, "name" | "size" | "text">,
  limit: number = MAX_REPLAY_BYTES,
): Promise<FileLoadResult> {
  const wrongType = fileTypeProblem(file.name);
  if (wrongType !== null) return { ok: false, error: wrongType };
  const tooLarge = sizeProblem(file.size, limit);
  if (tooLarge !== null) return { ok: false, error: tooLarge };
  return loadFile(file);
}

/** The header label for an opened replay file: `Replay file: <name>`. */
export function fileLabel(name: string): string {
  return `Replay file: ${name}`;
}
