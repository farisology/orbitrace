// Ticket #27: the time-zone arithmetic of Pulse. Fixed instants only, no clock. Daylight-saving
// dates are those of 2026: Europe/London changes at 01:00 UTC on 29 March and 25 October,
// America/New_York at 07:00 UTC on 8 March and 06:00 UTC on 1 November.
import { describe, expect, it } from "vitest";
import { createZoneClock, weekdayAndHour, PULSE_WEEKDAYS } from "../../src/index.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Every part `splitByLocalHour` visits, as `weekday-hour: minutes`. */
function split(zone: string, start: number, end: number): Record<string, number> {
  const clock = createZoneClock(zone);
  const parts: Record<string, number> = {};
  clock.splitByLocalHour(start, end, (weekday, hour, ms) => {
    const label = `${PULSE_WEEKDAYS[weekday]}-${hour}`;
    parts[label] = (parts[label] ?? 0) + ms / MINUTE;
  });
  return parts;
}

describe("weekdayAndHour", () => {
  it("numbers days Monday first from the Unix epoch, a Thursday", () => {
    expect(weekdayAndHour(0)).toEqual({ weekday: 3, hour: 0 });
    expect(weekdayAndHour(Date.UTC(2026, 10, 30, 23, 59))).toEqual({ weekday: 0, hour: 23 });
    expect(weekdayAndHour(Date.UTC(2026, 10, 29, 0, 0))).toEqual({ weekday: 6, hour: 0 });
  });

  it("works before 1970", () => {
    expect(weekdayAndHour(-1)).toEqual({ weekday: 2, hour: 23 });
  });
});

describe("createZoneClock", () => {
  it("resolves the zone through Intl and refuses an unknown one without repeating it", () => {
    expect(createZoneClock("UTC").timeZone).toBe("UTC");
    expect(createZoneClock("Europe/London").timeZone).toBe("Europe/London");
    expect(() => createZoneClock("Nowhere/Widget-City")).toThrow(RangeError);
    expect(() => createZoneClock("")).toThrow(RangeError);
    const message = ((): string => {
      try {
        createZoneClock("Nowhere/Widget-City");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toMatch(/time zone/);
    expect(message).not.toContain("Widget");
  });

  it("gives the offset on each side of a daylight-saving change", () => {
    const london = createZoneClock("Europe/London");
    const change = Date.UTC(2026, 2, 29, 1, 0);
    expect(london.offsetAt(change - 1)).toBe(0);
    expect(london.offsetAt(change)).toBe(HOUR);
    const ny = createZoneClock("America/New_York");
    expect(ny.offsetAt(Date.UTC(2026, 0, 15))).toBe(-5 * HOUR);
    expect(ny.offsetAt(Date.UTC(2026, 6, 15))).toBe(-4 * HOUR);
    expect(createZoneClock("Asia/Kolkata").offsetAt(0)).toBe(5.5 * HOUR);
  });

  it("gives the local weekday and hour of an instant", () => {
    const instant = Date.UTC(2026, 10, 29, 23, 30); // Sunday 23:30 UTC
    expect(createZoneClock("UTC").localTime(instant)).toMatchObject({ weekday: 6, hour: 23 });
    // Monday 08:30 in Tokyo (UTC+9).
    expect(createZoneClock("Asia/Tokyo").localTime(instant)).toEqual({
      weekday: 0,
      hour: 8,
      offsetMs: 9 * HOUR,
    });
  });
});

describe("splitByLocalHour", () => {
  it("adds up to exactly the interval and visits nothing for an empty one", () => {
    const start = Date.UTC(2026, 4, 4, 9, 17, 3, 211);
    const end = start + 5 * HOUR + 1234;
    let total = 0;
    createZoneClock("America/New_York").splitByLocalHour(start, end, (_d, _h, ms) => {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      total += ms;
    });
    expect(total).toBe(end - start);
    let calls = 0;
    createZoneClock("UTC").splitByLocalHour(end, end, () => (calls += 1));
    createZoneClock("UTC").splitByLocalHour(end, start, () => (calls += 1));
    expect(calls).toBe(0);
  });

  it("splits across the week boundary, Sunday night into Monday", () => {
    // Sunday 29 Nov 2026 23:30 to Monday 00:30, UTC.
    const start = Date.UTC(2026, 10, 29, 23, 30);
    expect(split("UTC", start, start + HOUR)).toEqual({ "sun-23": 30, "mon-0": 30 });
    // The same instants are Monday morning in Tokyo, inside one day.
    expect(split("Asia/Tokyo", start, start + HOUR)).toEqual({ "mon-8": 30, "mon-9": 30 });
    // And Sunday afternoon in New York.
    expect(split("America/New_York", start, start + HOUR)).toEqual({ "sun-18": 30, "sun-19": 30 });
  });

  it("gives the skipped hour nothing on a spring-forward day (London, 29 March 2026)", () => {
    // 00:30 GMT to 03:30 BST: two real hours.
    const start = Date.UTC(2026, 2, 29, 0, 30);
    expect(split("Europe/London", start, start + 2 * HOUR)).toEqual({
      "sun-0": 30,
      "sun-2": 60,
      "sun-3": 30,
    });
  });

  it("gives the repeated hour both real hours on a fall-back day (London, 25 October 2026)", () => {
    // 01:30 BST to 02:30 GMT: two real hours, of which 90 minutes are local 01:xx.
    const start = Date.UTC(2026, 9, 25, 0, 30);
    expect(split("Europe/London", start, start + 2 * HOUR)).toEqual({ "sun-1": 90, "sun-2": 30 });
  });

  it("handles New York's changes, which fall in the middle of a UTC day", () => {
    // 8 March 2026, 01:00 EST to 04:00 EDT: two real hours, local 02:xx does not exist.
    const spring = Date.UTC(2026, 2, 8, 6, 0);
    expect(split("America/New_York", spring, spring + 2 * HOUR)).toEqual({
      "sun-1": 60,
      "sun-3": 60,
    });
    // 1 November 2026, 00:00 EDT to 02:00 EST: three real hours, local 01:xx twice.
    const fall = Date.UTC(2026, 10, 1, 4, 0);
    expect(split("America/New_York", fall, fall + 3 * HOUR)).toEqual({
      "sun-0": 60,
      "sun-1": 120,
    });
  });

  it("puts hour boundaries at half past in a zone with a half-hour offset", () => {
    // 10:00 to 11:00 UTC is 15:30 to 16:30 in Kolkata (UTC+5:30).
    const start = Date.UTC(2026, 5, 3, 10, 0);
    expect(split("Asia/Kolkata", start, start + HOUR)).toEqual({ "wed-15": 30, "wed-16": 30 });
  });

  it("splits at a change that is not on an hour boundary (Lord Howe Island, half-hour DST)", () => {
    // Lord Howe Island moves from UTC+11 to UTC+10:30 at 02:00 local on 5 April 2026
    // (15:00 UTC on 4 April): local 01:30 to 02:00 happens twice.
    const clock = createZoneClock("Australia/Lord_Howe");
    const change = Date.UTC(2026, 3, 4, 15, 0);
    expect(clock.offsetAt(change - 1)).toBe(11 * HOUR);
    expect(clock.offsetAt(change)).toBe(10.5 * HOUR);
    // 01:00 (+11) for 2 real hours: 01:00-02:00 (+11), then 01:30-02:00 (+10:30), then 02:00-02:30.
    const start = change - HOUR;
    expect(split("Australia/Lord_Howe", start, start + 2 * HOUR)).toEqual({
      "sun-1": 90,
      "sun-2": 30,
    });
  });
});

describe("instantAt", () => {
  it("is the inverse of local time on an ordinary day", () => {
    const ny = createZoneClock("America/New_York");
    expect(ny.instantAt(Date.UTC(2026, 6, 4, 9, 15))).toBe(Date.UTC(2026, 6, 4, 13, 15));
    expect(createZoneClock("UTC").instantAt(Date.UTC(2026, 0, 1))).toBe(Date.UTC(2026, 0, 1));
    expect(createZoneClock("Asia/Kolkata").instantAt(Date.UTC(2026, 0, 1))).toBe(
      Date.UTC(2025, 11, 31, 18, 30),
    );
  });

  it("takes the earlier instant of a repeated hour and moves a skipped one forward", () => {
    const london = createZoneClock("Europe/London");
    // 25 October 2026: local 01:30 happens at 00:30 UTC (BST) and at 01:30 UTC (GMT).
    expect(london.instantAt(Date.UTC(2026, 9, 25, 1, 30))).toBe(Date.UTC(2026, 9, 25, 0, 30));
    // 29 March 2026: local 01:30 does not exist; it is read as GMT, which is 02:30 BST.
    expect(london.instantAt(Date.UTC(2026, 2, 29, 1, 30))).toBe(Date.UTC(2026, 2, 29, 1, 30));
    // Local midnight on either change day is unambiguous.
    expect(london.instantAt(Date.UTC(2026, 2, 29))).toBe(Date.UTC(2026, 2, 29));
    expect(london.instantAt(Date.UTC(2026, 9, 25))).toBe(Date.UTC(2026, 9, 24, 23, 0));
  });
});
