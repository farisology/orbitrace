// The store facts every host shows (#211): exists, bytes, and the size for people. Temporary
// folders only; runs on every Node (no store is opened).
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatHistoryBytes,
  historyStoreBytes,
  historyStoreExists,
  resolveHistoryLocation,
} from "../../src/sources/node.js";
import { useSandbox } from "./helpers.js";

useSandbox();

describe("historyStoreExists and historyStoreBytes", () => {
  it("report a missing store as absent with 0 bytes, and add up the database and its side files", () => {
    const location = resolveHistoryLocation();
    expect(historyStoreExists(location)).toBe(false);
    expect(historyStoreBytes(location)).toBe(0);
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(location.dbFile, Buffer.alloc(100));
    writeFileSync(`${location.dbFile}-wal`, Buffer.alloc(20));
    writeFileSync(`${location.dbFile}-shm`, Buffer.alloc(3));
    expect(historyStoreExists(location)).toBe(true);
    expect(historyStoreBytes(location)).toBe(123);
  });
});

describe("formatHistoryBytes", () => {
  it("uses B below 1000 and one decimal of KB, MB, GB and TB above", () => {
    expect(formatHistoryBytes(0)).toBe("0 B");
    expect(formatHistoryBytes(999)).toBe("999 B");
    expect(formatHistoryBytes(1000)).toBe("1.0 KB");
    expect(formatHistoryBytes(1_250_000)).toBe("1.3 MB");
    expect(formatHistoryBytes(4_000_000_000)).toBe("4.0 GB");
    expect(formatHistoryBytes(5e15)).toBe("5000.0 TB");
  });
});
