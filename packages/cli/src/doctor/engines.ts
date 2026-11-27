/**
 * A small check of a Node version against an `engines.node` range, for `orbitrace doctor`.
 * No dependency: it understands the range forms npm packages use for `engines`: `||`
 * alternatives, comparators joined by spaces (`>=20.19.0 <21`), `^`, `~`, `=`, `>`, `>=`, `<`,
 * `<=`, partial versions (`20`, `22.13`), `x` and `*`. Hyphen ranges and prerelease tags are not
 * understood; such a range gives `null`.
 */

type Version = readonly [number, number, number];

interface Bound {
  readonly op: ">=" | ">" | "<" | "<=";
  readonly version: Version;
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** `major.minor.patch` from a version such as `22.13.0` or `v20.19.1`, or null. */
export function parseVersion(value: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/;

function isWild(part: string | undefined): boolean {
  return part === undefined || part === "x" || part === "X" || part === "*";
}

/** The bounds one comparator stands for, or null when it is not understood. */
function comparatorBounds(token: string): Bound[] | null {
  if (token === "*" || token === "x" || token === "X") return [];
  const match = COMPARATOR.exec(token);
  if (match === null) return null;
  const op = match[1] ?? "=";
  const parts = [match[2], match[3], match[4]];
  // The number of leading parts that are given; a wild part makes the rest wild too.
  let given = 0;
  while (given < 3 && !isWild(parts[given])) given += 1;
  if (given === 0) return op === "<" || op === ">" ? null : [];
  const [major, minor, patch] = [0, 1, 2].map((index) =>
    index < given ? Number(parts[index]) : 0,
  ) as [number, number, number];
  const low: Version = [major, minor, patch];
  /** The first version after every version the partial value names. */
  const next: Version =
    given === 1 ? [major + 1, 0, 0] : given === 2 ? [major, minor + 1, 0] : [major, minor, patch];
  switch (op) {
    case ">=":
      return [{ op: ">=", version: low }];
    case ">":
      return given === 3 ? [{ op: ">", version: low }] : [{ op: ">=", version: next }];
    case "<":
      return [{ op: "<", version: low }];
    case "<=":
      return given === 3 ? [{ op: "<=", version: low }] : [{ op: "<", version: next }];
    case "=":
      return given === 3
        ? [
            { op: ">=", version: low },
            { op: "<=", version: low },
          ]
        : [
            { op: ">=", version: low },
            { op: "<", version: next },
          ];
    case "~":
      return [
        { op: ">=", version: low },
        { op: "<", version: given === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0] },
      ];
    case "^": {
      const upper: Version =
        major > 0 || given === 1
          ? [major + 1, 0, 0]
          : minor > 0 || given === 2
            ? [0, minor + 1, 0]
            : [0, 0, patch + 1];
      return [
        { op: ">=", version: low },
        { op: "<", version: upper },
      ];
    }
    default:
      return null;
  }
}

function meets(version: Version, bound: Bound): boolean {
  const order = compare(version, bound.version);
  switch (bound.op) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
  }
}

/**
 * Whether `version` is inside `range`. `null` when either one is not understood, so a caller
 * can say "could not check" instead of guessing.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (parsed === null || range.trim() === "") return null;
  let result = false;
  for (const alternative of range.split("||")) {
    // `>= 20` is written with a space sometimes; join an operator to its version.
    const tokens = alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
      .split(/\s+/)
      .filter((token) => token !== "");
    if (tokens.length === 0) return null;
    const bounds: Bound[] = [];
    for (const token of tokens) {
      const own = comparatorBounds(token);
      if (own === null) return null;
      bounds.push(...own);
    }
    if (bounds.every((bound) => meets(parsed, bound))) result = true;
  }
  return result;
}
