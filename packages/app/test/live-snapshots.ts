// Growing live snapshots of a synthetic session, built the way a host builds them: the real
// `parseSession` and `buildReplay` from @orbitrace/core, each snapshot at a later `now` with the
// one before as `previous`. The transcripts come from the seeded generator in
// @orbitrace/fixtures, so every value is invented.

import { buildReplay, parseSession, type ReplayModel } from "@orbitrace/core";
import { generateSession } from "@orbitrace/fixtures/generator";

type ScenarioName = Parameters<typeof generateSession>[0];

export interface LiveSnapshots {
  /** Each snapshot, in order. */
  readonly snapshots: readonly ReplayModel[];
  /** Seconds from the first line of each snapshot's `now`. */
  readonly offsets: readonly number[];
}

/**
 * Snapshots of `scenario` at `offsets` seconds after its first line (a later offset than the last
 * line gives the whole session).
 */
export async function liveSnapshots(
  scenario: ScenarioName,
  offsets: readonly number[],
): Promise<LiveSnapshots> {
  const session = generateSession(scenario);
  const files = new Map(session.files.map((file) => [file.path, file.content]));
  const lines = (path: string): string[] =>
    (files.get(path) ?? "").split("\n").filter((line) => line.length > 0);
  const main = lines(session.transcriptPath);
  const parsed = await parseSession({
    main,
    subagents: session.subagents.map((subagent) => ({
      agentId: subagent.agentId,
      meta: subagent.meta,
      lines: lines(subagent.transcriptPath),
    })),
  });
  const first = main
    .map((line) => (JSON.parse(line) as { timestamp?: string }).timestamp)
    .find((stamp): stamp is string => typeof stamp === "string");
  if (first === undefined) throw new Error("synthetic session has no timed line");
  const start = Date.parse(first);
  const snapshots: ReplayModel[] = [];
  let previous: ReplayModel | undefined;
  for (const offset of offsets) {
    const now = start + Math.round(offset * 1000);
    const model: ReplayModel = buildReplay(
      parsed,
      previous === undefined ? { now } : { now, previous },
    );
    snapshots.push(model);
    previous = model;
  }
  return { snapshots, offsets };
}

/**
 * The idle-gap scenario as a live session: a few busy seconds, a 240 s command, then a 2820 s idle
 * gap that the snapshot at 3065.6 s cuts for the first time, and a second cut in the last
 * snapshot. Offsets are seconds after the first line.
 */
export const IDLE_GAP_OFFSETS = [3.5, 243.5, 244.4, 3065.6, 3068.6, 3114, 3300] as const;

/** Index of the first snapshot in `IDLE_GAP_OFFSETS` that holds an idle cut. */
export const FIRST_CUT_INDEX = 3;
