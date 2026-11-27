// Pure helpers of follow live (#127): real-time mapping across snapshots and the badge words.
// Every value is invented.

import { describe, expect, it } from "vitest";
import { toRealSeconds, type ReplayWarp } from "@orbitrace/core";
import { FOLLOW_ANNOUNCEMENTS, followAnnouncement, statusLostAnnouncement } from "../src/announce";
import {
  CUT_NUDGE_SECONDS,
  behindSeconds,
  followStartTime,
  followStatusText,
  isFollowable,
  remapTime,
} from "../src/follow";
import { makeModel } from "./helpers";

/** Two cuts: 600 s removed at compressed 30, 120 s removed at compressed 50. */
const WARPS: readonly ReplayWarp[] = [
  { at: 30, skipped: 600 },
  { at: 50, skipped: 120 },
];

describe("remapTime and followStartTime", () => {
  it("keep a time before any new cut where it was", () => {
    const before = [WARPS[0] as ReplayWarp];
    expect(remapTime(before, 42, WARPS)).toBe(42);
    expect(followStartTime(before, 42, WARPS)).toBe(42);
  });

  it("keep the same real moment when the last cut grows", () => {
    // The old timeline cut 600 s at 30; the new one cut 660 s there (an idle stretch that went on).
    const before: ReplayWarp[] = [{ at: 30, skipped: 600 }];
    const after: ReplayWarp[] = [{ at: 30, skipped: 660 }];
    // Compressed 32 was real 632; now real 632 is inside the grown cut.
    expect(remapTime(before, 32, after)).toBe(30);
    const start = followStartTime(before, 32, after);
    expect(start).toBe(30 + CUT_NUDGE_SECONDS);
    // A following playhead never shows an earlier real time than before.
    expect(toRealSeconds(after, start)).toBeGreaterThanOrEqual(toRealSeconds(before, 32));
    // A later moment moves back on the compressed timeline but stays the same real moment.
    expect(toRealSeconds(after, remapTime(before, 100, after))).toBeCloseTo(
      toRealSeconds(before, 100),
      9,
    );
  });
});

describe("behindSeconds", () => {
  it("counts real seconds to the live edge, idle gaps included", () => {
    const model = makeModel(60); // one 600 s cut at 30, real length 660
    expect(behindSeconds(model, 60)).toBe(0);
    expect(behindSeconds(model, 50)).toBe(10);
    expect(behindSeconds(model, 20)).toBe(640);
  });
});

describe("followStatusText", () => {
  it("says following, how far behind, or not following at the edge", () => {
    expect(followStatusText(true, 500)).toBe("following");
    expect(followStatusText(false, 125)).toBe("2 min 5 s behind");
    expect(followStatusText(false, 7.9)).toBe("7 s behind");
    expect(followStatusText(false, 0.4)).toBe("not following");
    expect(followStatusText(false, Number.NaN)).toBe("not following");
  });
});

describe("isFollowable", () => {
  it("is true for a running session only", () => {
    expect(isFollowable("busy")).toBe(true);
    expect(isFollowable("idle")).toBe(true);
    expect(isFollowable("ended")).toBe(false);
    expect(isFollowable("unknown")).toBe(false);
    expect(isFollowable(null)).toBe(false);
    expect(isFollowable(undefined)).toBe(false);
  });
});

describe("followAnnouncement", () => {
  it("speaks on entering and leaving follow, and not when the session ended", () => {
    expect(followAnnouncement(false, true, true)).toBe(FOLLOW_ANNOUNCEMENTS.entered);
    expect(followAnnouncement(true, false, true)).toBe(FOLLOW_ANNOUNCEMENTS.left);
    expect(followAnnouncement(true, false, false)).toBeNull();
    expect(followAnnouncement(true, true, true)).toBeNull();
    expect(followAnnouncement(false, false, true)).toBeNull();
  });
});

describe("statusLostAnnouncement (#139)", () => {
  it("speaks when a followed running session's status becomes unknown", () => {
    expect(statusLostAnnouncement("busy", "unknown", true)).toBe(FOLLOW_ANNOUNCEMENTS.statusLost);
    expect(statusLostAnnouncement("idle", "unknown", true)).toBe(FOLLOW_ANNOUNCEMENTS.statusLost);
  });

  it("is silent when the view was not following, or nothing was lost", () => {
    expect(statusLostAnnouncement("busy", "unknown", false)).toBeNull();
    // Still unknown on a later snapshot: said once only.
    expect(statusLostAnnouncement("unknown", "unknown", true)).toBeNull();
    expect(statusLostAnnouncement("ended", "unknown", true)).toBeNull();
    expect(statusLostAnnouncement("busy", "ended", true)).toBeNull();
    expect(statusLostAnnouncement("busy", "idle", true)).toBeNull();
  });

  it("does not offer Go live or End, which are hidden then", () => {
    expect(FOLLOW_ANNOUNCEMENTS.statusLost).not.toMatch(/Go live|End/);
    expect(FOLLOW_ANNOUNCEMENTS.statusLost).not.toBe(FOLLOW_ANNOUNCEMENTS.left);
  });
});
