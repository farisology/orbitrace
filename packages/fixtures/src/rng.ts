/**
 * Seeded pseudo-random numbers for the fixture generator.
 *
 * Nothing in this package may call Math.random or read the clock: every value in a fixture
 * comes from a seed, so the same seed always writes the same bytes.
 */

export type Seed = number | string;

export interface Rng {
  /** The key this generator was created from. */
  readonly key: string;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /** A string of `length` characters drawn from `alphabet`. */
  chars(length: number, alphabet: string): string;
  /**
   * An independent generator for a named sub-stream. The result depends only on this
   * generator's key and the label, not on how many values were drawn before the call, so
   * adding a step to one agent does not change the values another agent draws.
   */
  fork(label: string): Rng;
}

/** FNV-1a, 32 bits. Turns a seed key into the starting state. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Create a generator. Numbers and strings that print the same are the same seed. */
export function createRng(seed: Seed): Rng {
  const key = String(seed);
  // mulberry32: a small public-domain generator with a 32-bit state.
  let state = hashSeed(key);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}) needs integers with min <= max`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError("pick() needs a non-empty list");
    return items[int(0, items.length - 1)] as T;
  };

  const chars = (length: number, alphabet: string): string => {
    if (alphabet.length === 0) throw new RangeError("chars() needs a non-empty alphabet");
    let out = "";
    for (let index = 0; index < length; index += 1) {
      out += alphabet.charAt(int(0, alphabet.length - 1));
    }
    return out;
  };

  return {
    key,
    next,
    int,
    pick,
    chance: (p) => next() < p,
    chars,
    fork: (label) => createRng(`${key}/${label}`),
  };
}
