/// <reference types="node" />
/**
 * Small facts about a history store that every host shows (#195, shared since #211): whether its
 * database file exists, how many bytes it and SQLite's side files take, and that size for people.
 * Read only: nothing here opens the store, loads `node:sqlite` or creates a file.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

import { existsSync, statSync } from "node:fs";
import type { HistoryLocation } from "./location.js";

/** Whether the store's database file exists. Reads only. */
export function historyStoreExists(location: HistoryLocation): boolean {
  return existsSync(location.dbFile);
}

/** The bytes of the database and the files SQLite keeps beside it; 0 for a missing file. */
export function historyStoreBytes(location: HistoryLocation): number {
  let total = 0;
  for (const file of [location.dbFile, `${location.dbFile}-wal`, `${location.dbFile}-shm`]) {
    try {
      total += statSync(file).size;
    } catch {
      // Not there.
    }
  }
  return total;
}

/** A byte count for people: B, KB, MB, GB or TB, base 1000, one decimal from KB up. */
export function formatHistoryBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
