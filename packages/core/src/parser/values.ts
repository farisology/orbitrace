/**
 * Defensive readers for values taken from a parsed transcript line.
 *
 * The transcript format has no published schema, so every value is `unknown` until one of
 * these readers accepts it. None of them throws.
 */

import type { EpochMs } from "../model/parsed.js";

/** A plain JSON object. */
export type JsonRecord = { readonly [key: string]: unknown };

/** The value when it is a plain object (not an array, not `null`), otherwise `null`. */
export function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** The value when it is an array, otherwise an empty array. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The value when it is a non-empty string, otherwise `null`. */
export function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The value when it is a boolean, otherwise `null`. */
export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** The value when it is a finite number, otherwise `null`. */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A token count: a finite, non-negative number, otherwise 0. */
export function asTokenCount(value: unknown): number {
  const n = asFiniteNumber(value);
  return n !== null && n >= 0 ? n : 0;
}

/** An ISO 8601 timestamp as Unix epoch milliseconds, or `null` when it cannot be read. */
export function parseTimestamp(value: unknown): EpochMs | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
