/**
 * Tickets #190 and #191: checking an in-memory replay model that may carry
 * `ReplayReplyDetails` (a reply's cache writes by lifetime and its own model id).
 *
 * Replay format v1 has no field for the details, and `validateReplay` stays exact: a replay file
 * that holds them is rejected. A model built with `BuildReplayOptions.replyDetails` does hold
 * them, so a host or app that passes such a model around checks it here instead: each detail is
 * checked on its own, then the rest of the model goes through the unchanged v1 schema check with
 * the details taken out. Nothing else is tolerated: any other extra property is still a problem.
 *
 * Problem lines have the same form as `describeReplayProblems` (`<JSON pointer>: <rule>`) and
 * never quote a value. Browser-safe.
 */

import { describeReplayProblems } from "../export/validate.js";
import type { ReplayModel, ReplayReplyDetails } from "../model/replay.js";
import { modelIdOf } from "./names.js";

/** The property names of `ReplayReplyDetails`: the only extras an in-memory reply may hold. */
export const REPLY_DETAIL_KEYS = [
  "cacheWrite5mTokens",
  "cacheWrite1hTokens",
  "model",
] as const satisfies readonly (keyof ReplayReplyDetails)[];

type Json = { [key: string]: unknown };

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` with `omit` left out. Walks every enumerable key, inherited ones included,
 * because the schema check does the same; so taking the details out hides nothing else from it.
 * Each key is defined as an own data property, never assigned: assigning an own `"__proto__"` key
 * (as `JSON.parse` makes one) would hit the prototype setter and hide that key from the v1 check.
 */
function copyWithout(value: Json, omit: ReadonlySet<string>): Json {
  const copy: Json = {};
  for (const key in value) {
    if (omit.has(key)) continue;
    Object.defineProperty(copy, key, {
      value: value[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

const DETAIL_KEYS: ReadonlySet<string> = new Set(REPLY_DETAIL_KEYS);
const NOTHING: ReadonlySet<string> = new Set();

/** Problems with the details of one reply, or none. */
function detailProblems(reply: Json, pointer: string): string[] {
  const problems: string[] = [];
  for (const key of ["cacheWrite5mTokens", "cacheWrite1hTokens"] as const) {
    if (!(key in reply)) continue;
    const value = reply[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      problems.push(`${pointer}/${key}: must be a whole number of tokens, 0 or more`);
    }
  }
  if ("model" in reply) {
    const value = reply["model"];
    if (typeof value !== "string" || modelIdOf(value) === null) {
      problems.push(`${pointer}/model: must be a model id`);
    }
  }
  return problems;
}

/**
 * The value with every reply's details taken out, and the problems found in those details.
 * A value that does not have the replay's outline (no `agents` list) is returned as it is.
 */
function splitDetails(value: unknown): { core: unknown; problems: string[] } {
  if (!isObject(value) || !Array.isArray(value["agents"])) return { core: value, problems: [] };
  const problems: string[] = [];
  const agents = (value["agents"] as unknown[]).map((agent, a) => {
    if (!isObject(agent) || !Array.isArray(agent["replies"])) return agent;
    const replies = (agent["replies"] as unknown[]).map((reply, r) => {
      if (!isObject(reply)) return reply;
      problems.push(...detailProblems(reply, `/agents/${a}/replies/${r}`));
      return copyWithout(reply, DETAIL_KEYS);
    });
    return { ...copyWithout(agent, NOTHING), replies };
  });
  return { core: { ...copyWithout(value, NOTHING), agents }, problems };
}

/**
 * Why a value is not a valid in-memory replay model: a replay v1, whose replies may also hold
 * `ReplayReplyDetails` (whole token counts of at least 0, a model id). One line per problem, or an
 * empty list when it is valid. Use it, not `describeReplayProblems`, for a model built with
 * `BuildReplayOptions.replyDetails`; use `describeReplayProblems` for a replay file.
 */
export function describeReplayModelProblems(value: unknown): readonly string[] {
  const { core, problems } = splitDetails(value);
  return [...problems, ...describeReplayProblems(core)];
}

/** True when `describeReplayModelProblems` finds nothing. */
export function validateReplayModel(value: unknown): value is ReplayModel {
  return describeReplayModelProblems(value).length === 0;
}

/**
 * The model without any reply details, for a receiver that only accepts a replay file's shape.
 * The model, every agent and every reply are new objects (the input is not changed); tool calls,
 * totals and warps are shared with the input. `exportReplay` needs no such step: its allow-list
 * already leaves the details out.
 */
export function withoutReplyDetails(model: ReplayModel): ReplayModel {
  return splitDetails(model).core as ReplayModel;
}
