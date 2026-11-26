/**
 * Invented words and sentences for fixtures.
 *
 * Every piece of free text a fixture contains starts with the word "Synthetic", so nobody
 * can mistake it for a real prompt, reply or command output. Nothing here is taken from a
 * real session.
 */
import type { Rng } from "./rng.js";

/** The marker every invented sentence starts with. */
export const SYNTHETIC_MARKER = "Synthetic";

const THINGS = [
  "lantern",
  "kite",
  "marble",
  "quill",
  "juniper",
  "tidepool",
  "compass",
  "thimble",
  "pebble",
  "teacup",
  "windmill",
  "sundial",
  "abacus",
  "kazoo",
] as const;

const PLACES = [
  "shelf",
  "drawer",
  "attic",
  "greenhouse",
  "workbench",
  "pantry",
  "boathouse",
  "balcony",
] as const;

const ACTIONS = [
  "tally",
  "sort",
  "label",
  "polish",
  "recount",
  "catalogue",
  "untangle",
  "repaint",
] as const;

const FOLDERS = ["src", "test", "docs", "scripts"] as const;

const EXTENSIONS: Record<(typeof FOLDERS)[number], string> = {
  src: "ts",
  test: "test.ts",
  docs: "md",
  scripts: "mjs",
};

function thing(rng: Rng): string {
  return rng.pick(THINGS);
}

function plural(word: string): string {
  return `${word}s`;
}

/** An invented user prompt. */
export function promptText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} prompt: please ${rng.pick(ACTIONS)} the ${plural(thing(rng))} in the ${rng.pick(PLACES)}.`;
}

/** An invented assistant reply. */
export function replyText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} reply: the ${thing(rng)} ledger now lists ${rng.int(2, 40)} entries; next is the ${rng.pick(PLACES)}.`;
}

/** An invented thinking block. */
export function thinkingText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} thinking: compare the ${thing(rng)} tally with the ${thing(rng)} index before the next step.`;
}

/** Invented output of a tool call that worked. */
export function resultText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} result: ${rng.int(1, 60)} ${plural(thing(rng))} found in the ${rng.pick(PLACES)}.`;
}

/** Invented output of a tool call that failed. */
export function errorText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} error: the ${thing(rng)} ledger in the ${rng.pick(PLACES)} could not be opened.`;
}

/** An invented subagent task description (the `description` of an Agent call). */
export function taskDescription(rng: Rng): string {
  return `${SYNTHETIC_MARKER} task: ${rng.pick(ACTIONS)} the ${plural(thing(rng))}`;
}

/** An invented final answer a subagent hands back to its parent. */
export function handbackText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} handback: ${rng.int(1, 30)} ${plural(thing(rng))} checked, nothing left in the ${rng.pick(PLACES)}.`;
}

/** An invented session title. */
export function titleText(rng: Rng): string {
  return `${SYNTHETIC_MARKER} session: ${thing(rng)} ${rng.pick(PLACES)} tidy-up`;
}

/** An invented shell command. It names no real program. */
export function commandText(rng: Rng): string {
  return `synthetic-${rng.pick(ACTIONS)} --${thing(rng)} ${rng.int(1, 9)}`;
}

/** An invented search word. */
export function searchWord(rng: Rng): string {
  return `synthetic_${thing(rng)}`;
}

/** An invented file path relative to the project folder, such as `src/kite-ledger.ts`. */
export function relativeFilePath(rng: Rng): string {
  const folder = rng.pick(FOLDERS);
  return `${folder}/${thing(rng)}-${rng.pick(PLACES)}.${EXTENSIONS[folder]}`;
}
