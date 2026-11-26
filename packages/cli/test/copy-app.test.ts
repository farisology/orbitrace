import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SKIPPED_ENTRIES, copyAppBundle } from "../scripts/copy-app.mjs";
import { makeTempDir, removeTempDirs } from "./helpers.js";

afterAll(() => {
  removeTempDirs();
});

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

describe("copyAppBundle", () => {
  it("copies the built app without its type declarations", () => {
    const root = makeTempDir();
    const source = join(root, "app-dist");
    writeFile(join(source, "index.html"), "<!doctype html>");
    writeFile(join(source, "assets", "index-0000.js"), "console.log(1)");
    writeFile(join(source, "types", "transport.d.ts"), "export {};");
    const target = join(root, "cli-dist", "app");

    expect(SKIPPED_ENTRIES).toEqual(["types"]);
    expect(copyAppBundle(source, target)).toEqual(["assets/index-0000.js", "index.html"]);
    expect(readFileSync(join(target, "index.html"), "utf8")).toBe("<!doctype html>");
    expect(readFileSync(join(target, "assets", "index-0000.js"), "utf8")).toBe("console.log(1)");
    expect(existsSync(join(target, "types"))).toBe(false);
  });

  it("replaces an older copy, so stale assets do not linger", () => {
    const root = makeTempDir();
    const source = join(root, "app-dist");
    writeFile(join(source, "index.html"), "new");
    const target = join(root, "app");
    writeFile(join(target, "assets", "old.js"), "old");
    copyAppBundle(source, target);
    expect(existsSync(join(target, "assets", "old.js"))).toBe(false);
    expect(readFileSync(join(target, "index.html"), "utf8")).toBe("new");
  });

  it("fails when the app is not built, and leaves the target alone", () => {
    const root = makeTempDir();
    const target = join(root, "app");
    writeFile(join(target, "index.html"), "kept");
    expect(() => copyAppBundle(join(root, "nothing"), target)).toThrow(/not built/);
    expect(readFileSync(join(target, "index.html"), "utf8")).toBe("kept");
  });
});
