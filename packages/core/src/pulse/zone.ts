/**
 * Ticket #27: wall-clock arithmetic in a named time zone for Pulse. Browser-safe: it uses only
 * `Intl.DateTimeFormat`, which every supported Node and browser has, and whole milliseconds.
 *
 * The one question asked of `Intl` is "what is the zone's offset from UTC at this instant?".
 * Everything else (the local hour, the day of the week, where the next local hour starts) is
 * integer arithmetic on `instant + offset`. Where the offset changes (a daylight-saving change),
 * the exact instant of the change is found by bisection, so an interval is split at it and each
 * part lands in the local hour it really belongs to: on a spring-forward day the skipped local
 * hour gets nothing, and on a fall-back day the repeated local hour gets both of its real hours.
 *
 * Assumption: a zone changes its offset at most once within one local hour. Every zone in the
 * IANA database keeps to this.
 */

/** Milliseconds in one hour and in one day. */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Days of the week as Pulse numbers them: ISO 8601 order, Monday first. Index 0 is Monday and 6
 * is Sunday; a week starts on Monday at 00:00 local time.
 */
export const PULSE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type PulseWeekday = (typeof PULSE_WEEKDAYS)[number];

/** `a` divided by `b`, rounded down, for any sign of `a` (`b` > 0). */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** `a` modulo `b` in `[0, b)`, for any sign of `a` (`b` > 0). */
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** Where an instant falls in local time. */
export interface LocalTime {
  /** Day of the week, 0 (Monday) to 6 (Sunday). */
  readonly weekday: number;
  /** Hour of the day, 0 to 23. */
  readonly hour: number;
  /** Offset of the zone from UTC at this instant, in milliseconds (east positive). */
  readonly offsetMs: number;
}

/** A time zone, resolved once, with the conversions Pulse needs. */
export interface ZoneClock {
  /** The IANA name `Intl` resolved the zone to, for example `Europe/London` or `UTC`. */
  readonly timeZone: string;
  /** Offset from UTC at `instant` (epoch milliseconds), in milliseconds, east positive. */
  offsetAt(instant: number): number;
  /** Day of the week and hour at `instant`. */
  localTime(instant: number): LocalTime;
  /**
   * The instant (epoch milliseconds) of a wall-clock time in this zone, given as milliseconds
   * since 1970-01-01 00:00 local (for example `Date.UTC(2026, 2, 29, 1, 30)` for 01:30 on 29 March
   * 2026). On a repeated hour (a fall-back change) it is the earlier of the two instants. On a
   * skipped hour (a spring-forward change) the time is read with the offset before the change, so
   * it lands that far after it: 01:30 on London's spring-forward day is 02:30 BST.
   */
  instantAt(localMs: number): number;
  /**
   * Split `[start, end)` (epoch milliseconds) at every local hour boundary and every offset
   * change, and call `visit` once per part with its day of the week, its hour and its length.
   * The lengths add up to exactly `end - start`. Nothing is called when `end <= start`.
   */
  splitByLocalHour(
    start: number,
    end: number,
    visit: (weekday: number, hour: number, ms: number) => void,
  ): void;
}

/**
 * The weekday (Monday 0) and hour of a local wall-clock time given as milliseconds since
 * 1970-01-01 00:00 local. 1970-01-01 was a Thursday, day 3 when Monday is 0.
 */
export function weekdayAndHour(localMs: number): { weekday: number; hour: number } {
  return {
    weekday: mod(floorDiv(localMs, DAY_MS) + 3, 7),
    hour: floorDiv(mod(localMs, DAY_MS), HOUR_MS),
  };
}

const NUMERIC_PARTS = ["year", "month", "day", "hour", "minute", "second"] as const;

/**
 * Resolve `timeZone` (an IANA name such as `Europe/London`, or `UTC`) with `Intl`. Throws a
 * `RangeError` whose message does not repeat the value when `Intl` does not know the zone.
 */
export function createZoneClock(timeZone: string): ZoneClock {
  let format: Intl.DateTimeFormat;
  try {
    if (typeof timeZone !== "string" || timeZone.trim() === "") throw new RangeError("empty");
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone.trim(),
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
  } catch {
    throw new RangeError("pulse: the time zone is not known to Intl");
  }
  const resolved = format.resolvedOptions().timeZone;

  const offsetAt = (instant: number): number => {
    const seconds = instant - mod(instant, 1000);
    const values: Record<string, number> = {};
    let bc = false;
    for (const part of format.formatToParts(seconds)) {
      if (part.type === "era") bc = part.value.startsWith("B");
      else if ((NUMERIC_PARTS as readonly string[]).includes(part.type)) {
        values[part.type] = Number(part.value);
      }
    }
    const yearOfEra = values.year ?? 1970;
    const year = bc ? 1 - yearOfEra : yearOfEra;
    const date = new Date(0);
    date.setUTCFullYear(year, (values.month ?? 1) - 1, values.day ?? 1);
    date.setUTCHours(values.hour ?? 0, values.minute ?? 0, values.second ?? 0, 0);
    return date.getTime() - seconds;
  };

  const localTime = (instant: number): LocalTime => {
    const offsetMs = offsetAt(instant);
    return { ...weekdayAndHour(instant + offsetMs), offsetMs };
  };

  const instantAt = (localMs: number): number => {
    // Offsets well before and after: at most one change lies between them (see the file header).
    const before = offsetAt(localMs - 14 * HOUR_MS);
    const after = offsetAt(localMs + 14 * HOUR_MS);
    const valid = [localMs - before, localMs - after].filter(
      (instant) => instant + offsetAt(instant) === localMs,
    );
    return valid.length > 0 ? Math.min(...valid) : localMs - before;
  };

  /** The first instant in `(from, to]` whose offset is not `offset`; `to` must differ. */
  const changeBetween = (from: number, to: number, offset: number): number => {
    let lo = from;
    let hi = to;
    while (hi - lo > 1) {
      const mid = lo + floorDiv(hi - lo, 2);
      if (offsetAt(mid) === offset) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  const splitByLocalHour: ZoneClock["splitByLocalHour"] = (start, end, visit) => {
    let t = start;
    while (t < end) {
      const offset = offsetAt(t);
      const local = t + offset;
      const nextHour = (floorDiv(local, HOUR_MS) + 1) * HOUR_MS - offset;
      let partEnd = Math.min(nextHour, end);
      if (offsetAt(partEnd - 1) !== offset) partEnd = changeBetween(t, partEnd - 1, offset);
      const { weekday, hour } = weekdayAndHour(local);
      visit(weekday, hour, partEnd - t);
      t = partEnd;
    }
  };

  return { timeZone: resolved, offsetAt, localTime, instantAt, splitByLocalHour };
}
