import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isEntryPoint } from "../src/entry.js";
import { makeTempDir, removeTempDirs } from "./tmp.js";

afterEach(removeTempDirs);

describe("isEntryPoint", () => {
  it("is true when the module is the file Node was started with", () => {
    const file = join(makeTempDir(), "command.js");
    writeFileSync(file, "");
    expect(isEntryPoint(pathToFileURL(file).href, file)).toBe(true);
  });

  it("is true when Node was started through a link to the module", () => {
    const dir = makeTempDir();
    const file = join(dir, "command.js");
    const link = join(dir, "link.js");
    writeFileSync(file, "");
    symlinkSync(file, link);
    expect(isEntryPoint(pathToFileURL(file).href, link)).toBe(true);
  });

  it("is false for another file, a file that does not exist, and no entry at all", () => {
    const dir = makeTempDir();
    const file = join(dir, "command.js");
    const other = join(dir, "other.js");
    writeFileSync(file, "");
    writeFileSync(other, "");
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(url, other)).toBe(false);
    expect(isEntryPoint(url, join(dir, "absent.js"))).toBe(false);
    // A test runner starts Node with its own file, never with a module of this package.
    expect(isEntryPoint(url)).toBe(false);
    expect(isEntryPoint(import.meta.url)).toBe(false);
  });
});
