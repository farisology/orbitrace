/**
 * Keyboard shortcuts for the whole page: space plays and pauses, the arrows scrub.
 *
 * | key                 | action                         |
 * | ------------------- | ------------------------------ |
 * | Space, K            | play or pause                  |
 * | Left / Right        | back / forward 5 s             |
 * | Shift+Left / Right  | back / forward 30 s            |
 * | Home / End          | start / end                    |
 * | Escape              | clear the selection            |
 *
 * Keys typed into a control that uses them itself (a text field, a select, a slider, a button)
 * are left to that control, so space on a focused button presses it once, not twice.
 */

/** Seconds of replay time one arrow press moves. */
export const SCRUB_STEP = 5;
/** Seconds of replay time one arrow press moves with Shift held. */
export const SCRUB_STEP_LARGE = 30;

export type KeyAction =
  | { readonly type: "toggle" }
  | { readonly type: "seekBy"; readonly delta: number }
  | { readonly type: "seekTo"; readonly to: "start" | "end" }
  | { readonly type: "clearSelection" };

export interface KeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** The action for a key press, or `null` when the key is not a shortcut. Pure. */
export function keyAction(event: KeyInput): KeyAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.key) {
    case " ":
    case "Spacebar":
    case "k":
    case "K":
      return { type: "toggle" };
    case "ArrowLeft":
      return { type: "seekBy", delta: -(event.shiftKey ? SCRUB_STEP_LARGE : SCRUB_STEP) };
    case "ArrowRight":
      return { type: "seekBy", delta: event.shiftKey ? SCRUB_STEP_LARGE : SCRUB_STEP };
    case "Home":
      return { type: "seekTo", to: "start" };
    case "End":
      return { type: "seekTo", to: "end" };
    case "Escape":
      return { type: "clearSelection" };
    default:
      return null;
  }
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "number",
  "password",
  "url",
  "tel",
]);

/** Keys a native slider uses itself. Space and K are not among them, so they still play and pause. */
const SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * True when the focused element handles this key itself. Space activates buttons, links and
 * check boxes; arrows, Home, End and Page keys move sliders (space on a slider still plays and
 * pauses); arrows move selects; every key types into text fields.
 */
export function targetHandlesKey(target: EventTarget | null, key: string): boolean {
  if (target === null || typeof (target as Element).tagName !== "string") return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((element as HTMLInputElement).type || "text").toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) return true;
    if (type === "range") return SLIDER_KEYS.has(key);
    return key === " " || key === "Spacebar";
  }
  if (tag === "button" || tag === "a" || tag === "summary") {
    return key === " " || key === "Spacebar" || key === "Enter";
  }
  return false;
}
