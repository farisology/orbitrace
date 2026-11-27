// No file of this package imports another package through a relative path (#197). Another
// package is reached by its name and one of the entries its `exports` lists, such as
// `@orbitrace/core`, `@orbitrace/app/transport` or `@orbitrace/fixtures/wire`: a relative path
// into its folder depends on where a file sits and skips the entry the extension's bundle uses.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", ".vscode-test"]);

/** Every source file under `dir`, as absolute paths. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });
}

/** The module names `text` imports: `from "x"`, `import "x"`, `import("x")` and `require("x")`. */
function importedModules(text: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]+)\1/g;
  return [...text.matchAll(pattern)].map((match) => match[2] as string);
}

/** The relative imports of `file` that resolve to a place outside `packageDir`. */
function importsLeavingPackage(packageDir: string, file: string, text: string): string[] {
  return importedModules(text).filter((name) => {
    if (!name.startsWith(".")) return false;
    const target = relative(packageDir, resolve(dirname(file), name));
    return target === ".." || target.startsWith(`..${sep}`);
  });
}

// Written with a placeholder, so this file's own text holds no import that leaves the package.
const sample = (name: string): string =>
  ["import { a } from NAME;", "const b = await import(NAME);", 'import "./local.js";']
    .join("\n")
    .replaceAll("NAME", JSON.stringify(name));

describe("importsLeavingPackage", () => {
  const file = join(PACKAGE_DIR, "test", "example.test.ts");

  it("finds a relative import into another package, static or dynamic", () => {
    const name = ["..", "..", "app", "src", "webview-transport"].join("/");
    expect(importsLeavingPackage(PACKAGE_DIR, file, sample(name))).toEqual([name, name]);
    const upOnly = ["..", ".."].join("/");
    expect(importsLeavingPackage(PACKAGE_DIR, file, sample(upOnly))).toEqual([upOnly, upOnly]);
  });

  it("allows relative imports inside the package and imports by package name", () => {
    for (const name of ["../src/message-host.js", "./helpers.js", "@orbitrace/core", "node:fs"]) {
      expect(importsLeavingPackage(PACKAGE_DIR, file, sample(name))).toEqual([]);
    }
  });
});

describe("the files of this package", () => {
  it("import other packages by name, never by a relative path", () => {
    const files = sourceFiles(PACKAGE_DIR);
    // The scan reached the sources, the tests, the scripts and the integration test.
    const folders = new Set(files.map((file) => relative(PACKAGE_DIR, file).split(sep)[0]));
    expect([...folders].sort()).toEqual(
      expect.arrayContaining(["scripts", "src", "test", "test-integration"]),
    );
    const offenders = files.flatMap((file) =>
      importsLeavingPackage(PACKAGE_DIR, file, readFileSync(file, "utf8")).map(
        (name) => `${relative(PACKAGE_DIR, file).split(sep).join("/")}: ${name}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
