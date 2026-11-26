/**
 * Ticket #18. Schema validation of replay v1 values.
 *
 * Uses the validator precompiled from `schema/replay-v1.schema.json` (see
 * `replay-v1-validator.generated.ts`), so it runs in Node, in a browser and in an editor webview
 * without reading the schema from disk and without `eval` or `new Function`.
 *
 * Error messages name the location (a JSON pointer) and the rule that failed. They never quote a
 * value from the input, so a message can be logged or pasted into an issue without leaking what
 * the rejected file held. A property name is shown only when it looks like an identifier.
 */
import type { ValidateReplay } from "../api.js";
import type { ReplayModel } from "../model/replay.js";
import { validate as generatedValidate } from "./replay-v1-validator.generated.js";

/** The part of an Ajv error object this module reads. */
interface SchemaError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface CompiledValidator {
  (data: unknown): boolean;
  errors?: readonly SchemaError[] | null;
}

const compiled = generatedValidate as unknown as CompiledValidator;

/** At most this many problems are listed; the rest are counted. */
export const MAX_REPORTED_PROBLEMS = 20;

const SAFE_PROPERTY_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,31}$/;

function describe(error: SchemaError): string {
  const where = error.instancePath === "" ? "(root)" : error.instancePath;
  let what = error.message ?? `fails the ${error.keyword} rule`;
  if (error.keyword === "additionalProperties") {
    const name = error.params.additionalProperty;
    what =
      typeof name === "string" && SAFE_PROPERTY_NAME.test(name)
        ? `has a property the format does not allow: "${name}"`
        : "has a property the format does not allow (name not shown)";
  }
  return `${where}: ${what}`;
}

/** Runs the schema check once and returns the problems found, empty when the value is valid. */
function check(value: unknown): string[] {
  if (compiled(value)) return [];
  const problems = [...new Set((compiled.errors ?? []).map(describe))];
  if (problems.length === 0) return ["(root): is not a valid replay"];
  if (problems.length <= MAX_REPORTED_PROBLEMS) return problems;
  const hidden = problems.length - MAX_REPORTED_PROBLEMS;
  return [...problems.slice(0, MAX_REPORTED_PROBLEMS), `... and ${hidden} more`];
}

/**
 * Lists why a value is not a valid replay v1, one line per problem (`<pointer>: <rule>`), or an
 * empty list when it is valid. Extra properties are problems here: unlike `exportReplay`, this
 * does not drop them.
 */
export function describeReplayProblems(value: unknown): readonly string[] {
  return check(value);
}

/** Thrown by `exportReplay` and `assertReplay` when a value is not a valid replay v1. */
export class ReplayValidationError extends Error {
  /** One line per problem, as returned by `describeReplayProblems`. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Not a valid Orbitrace replay (format version 1):\n- ${problems.join("\n- ")}`);
    this.name = "ReplayValidationError";
    this.problems = problems;
  }
}

/**
 * Checks an unknown value (for example a dropped `.replay.json`, after `JSON.parse`) against the
 * v1 schema. Exact: a value with any property the schema does not list is rejected. Use
 * `describeReplayProblems` to say why a value was rejected.
 */
export const validateReplay: ValidateReplay = (value: unknown): value is ReplayModel =>
  compiled(value);

/** Like `validateReplay`, but throws a `ReplayValidationError` listing the problems. */
export function assertReplay(value: unknown): asserts value is ReplayModel {
  const problems = check(value);
  if (problems.length > 0) throw new ReplayValidationError(problems);
}
