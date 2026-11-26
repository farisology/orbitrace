/**
 * Two small readers of parsed JSON, used to report on golden replay files: where two values
 * differ, and where a key from a list appears. Pure: no Node import.
 *
 * Both name a place the way JavaScript would reach it from the root, for example
 * `agents[3].tools[2].end`. The root itself is written `(root)`.
 */

/** At most this many differences are listed by default; the rest are counted. */
export const DEFAULT_DIFFERENCE_LIMIT = 20;

/** Longest value shown in a difference line, in characters. */
const SHOWN_VALUE_LENGTH = 60;

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  if (!PLAIN_KEY.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path === "" ? key : `${path}.${key}`;
}

function shown(path: string): string {
  return path === "" ? "(root)" : path;
}

/** A value short enough to read in one line. Lists and objects are named, not printed. */
function brief(value: unknown): string {
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  if (isObject(value)) return `an object with ${Object.keys(value).length} key(s)`;
  const text = JSON.stringify(value) ?? String(value);
  return text.length > SHOWN_VALUE_LENGTH ? `${text.slice(0, SHOWN_VALUE_LENGTH)}...` : text;
}

function collect(committed: unknown, regenerated: unknown, path: string, found: string[]): void {
  if (Array.isArray(committed) && Array.isArray(regenerated)) {
    if (committed.length !== regenerated.length) {
      found.push(
        `${shown(path)}: committed has ${committed.length} item(s), regenerated has ${regenerated.length}`,
      );
    }
    const shared = Math.min(committed.length, regenerated.length);
    for (let index = 0; index < shared; index += 1) {
      collect(committed[index], regenerated[index], child(path, index), found);
    }
    return;
  }
  if (isObject(committed) && isObject(regenerated)) {
    for (const key of Object.keys(committed)) {
      const at = child(path, key);
      if (!Object.hasOwn(regenerated, key)) {
        found.push(`${at}: only in the committed file (${brief(committed[key])})`);
      } else {
        collect(committed[key], regenerated[key], at, found);
      }
    }
    for (const key of Object.keys(regenerated)) {
      if (!Object.hasOwn(committed, key)) {
        found.push(`${child(path, key)}: only in the regenerated one (${brief(regenerated[key])})`);
      }
    }
    return;
  }
  if (!Object.is(committed, regenerated)) {
    found.push(`${shown(path)}: committed ${brief(committed)}, regenerated ${brief(regenerated)}`);
  }
}

/**
 * Where two parsed JSON values differ, one line per difference, in the order a reader meets
 * them in the committed value. Empty when the values hold the same data; the order of an
 * object's keys does not count as a difference.
 *
 * - a value that changed: `agents[1].end: committed 12.5, regenerated 13`;
 * - a list that grew or shrank: `agents[1].tools: committed has 4 item(s), regenerated has 5`,
 *   followed by the differences among the items both have;
 * - a key on one side only: `totals.replies: only in the committed file (8)`.
 *
 * At most `limit` lines are returned, then one line that counts the rest.
 */
export function describeJsonDifferences(
  committed: unknown,
  regenerated: unknown,
  limit: number = DEFAULT_DIFFERENCE_LIMIT,
): string[] {
  const found: string[] = [];
  collect(committed, regenerated, "", found);
  const kept = Math.max(0, Math.floor(limit));
  if (found.length <= kept) return found;
  return [...found.slice(0, kept), `... and ${found.length - kept} more difference(s)`];
}

/**
 * Every place in a parsed JSON value where an object has one of `keys` as its own key, at any
 * depth, in document order. Used to prove a replay holds no key the contract forbids.
 */
export function findKeys(value: unknown, keys: readonly string[]): string[] {
  const wanted = new Set(keys);
  const found: string[] = [];
  const walk = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, child(path, index)));
    } else if (isObject(current)) {
      for (const key of Object.keys(current)) {
        const at = child(path, key);
        if (wanted.has(key)) found.push(at);
        walk(current[key], at);
      }
    }
  };
  walk(value, "");
  return found;
}
