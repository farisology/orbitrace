/**
 * Where the timeline's lane list should scroll (issue 144). Pure.
 *
 * The lanes scroll inside the dock, which has a fixed share of the height, so a followed session
 * that adds agents never shrinks the orrery. Two things keep lanes reachable:
 *
 * - While following, a newly added lane is scrolled into view, unless the user has scrolled the
 *   lanes away from their end (the last lane is no longer wholly visible: `isInView`), or doing
 *   so would hide a lane that must stay visible (the selected agent's, or the one with keyboard
 *   focus).
 * - When the selection changes, the selected agent's lane is scrolled into view.
 *
 * Positions are pixels from the top of the scrolling list (`offsetTop` against the timeline body,
 * which is its offset parent), so they do not change as it scrolls.
 */

/** A lane's vertical extent in the scrolling list, in pixels. */
export interface LaneSpan {
  readonly top: number;
  readonly bottom: number;
}

/** The visible part of a scrolling list: where it is scrolled to and how tall it is. */
export interface ScrollView {
  readonly scrollTop: number;
  readonly height: number;
}

/** Whether `span` lies wholly inside `view`. */
export function isInView(view: ScrollView, span: LaneSpan): boolean {
  return span.top >= view.scrollTop && span.bottom <= view.scrollTop + view.height;
}

/**
 * The scroll position that brings `span` into `view` with the smallest move, or `null` when it is
 * already wholly visible or the list has no height (not laid out). A span taller than the view is
 * aligned to its top.
 */
export function revealScrollTop(view: ScrollView, span: LaneSpan): number | null {
  if (!(view.height > 0) || isInView(view, span)) return null;
  if (span.top < view.scrollTop || span.bottom - span.top >= view.height) {
    return Math.max(0, span.top);
  }
  return Math.max(0, span.bottom - view.height);
}

/**
 * The scroll position that shows a newly added lane, or `null` to leave the list where it is:
 * when the lane is already visible, or when showing it would push any of `keep` (lanes that
 * must stay visible and are visible now) out of view.
 */
export function newLaneScrollTop(
  view: ScrollView,
  added: LaneSpan,
  keep: readonly LaneSpan[] = [],
): number | null {
  const next = revealScrollTop(view, added);
  if (next === null) return null;
  const after: ScrollView = { scrollTop: next, height: view.height };
  const hides = keep.some((span) => isInView(view, span) && !isInView(after, span));
  return hides ? null : next;
}
