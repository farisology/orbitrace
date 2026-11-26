/**
 * Streaming JSONL reader. Reads one transcript line at a time and never keeps the raw text.
 *
 * Accepts the `LineSource` shape from the contract (a sync or async iterable of strings), so
 * it runs on the host and in the browser alike. It is tolerant of how the lines arrive:
 * an item that holds several lines (for example a whole dropped file as one string) is
 * split on line breaks, a byte order mark at the very start is removed, and blank lines are
 * ignored and not counted.
 */

import type { LineSource } from "../model/raw.js";
import { asRecord, type JsonRecord } from "./values.js";

/** One non-blank line: either a JSON object, or something that was not one. */
export type LineRecord =
  { readonly kind: "object"; readonly value: JsonRecord } | { readonly kind: "malformed" };

const LINE_BREAK = /\r?\n|\r/;
const BYTE_ORDER_MARK = "\uFEFF";

/** Parse one line of text. Never throws. */
export function parseJsonLine(text: string): LineRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  const record = asRecord(value);
  return record === null ? { kind: "malformed" } : { kind: "object", value: record };
}

/**
 * Yield one `LineRecord` per non-blank line of the source, in order. Items that are not
 * strings count as malformed lines.
 */
export async function* readJsonLines(source: LineSource): AsyncGenerator<LineRecord> {
  let first = true;
  for await (const item of source as AsyncIterable<unknown>) {
    if (typeof item !== "string") {
      first = false;
      yield { kind: "malformed" };
      continue;
    }
    for (const part of item.split(LINE_BREAK)) {
      let text = part;
      if (first) {
        if (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(BYTE_ORDER_MARK.length);
        first = false;
      }
      if (text.trim() === "") continue;
      yield parseJsonLine(text);
    }
  }
}
