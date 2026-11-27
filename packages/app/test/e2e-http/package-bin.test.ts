// @vitest-environment node
/**
 * The end-to-end tests find the `orbitrace` command through the package's name and the bin its
 * manifest names, not through the CLI's folder layout (#213). Packages here are invented and
 * written to a temporary folder.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_BIN, CLI_PACKAGE, resolvePackageBin } from "./cli-server";

describe("resolvePackageBin", () => {
  let root: string;
  let require: NodeJS.Require;

  /** Write an invented package with this manifest into the temporary node_modules. */
  function writePackage(name: string, manifest: Record<string, unknown>): string {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "0.0.0", ...manifest }),
    );
    return dir;
  }

  beforeAll(() => {
    // Real path: require resolves symbolic links (macOS's temporary folder is one).
    root = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-package-bin-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "example-host" }));
    require = createRequire(join(root, "package.json"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("names the file of a bin from a map of bins, built or not", () => {
    const dir = writePackage("example-tool", {
      bin: { "example-tool": "./out/cli.js", other: "./out/other.js" },
    });
    expect(resolvePackageBin(require, "example-tool", "example-tool")).toBe(
      join(dir, "out", "cli.js"),
    );
    expect(resolvePackageBin(require, "example-tool", "other")).toBe(join(dir, "out", "other.js"));
  });

  it("names the file of a single string bin", () => {
    const dir = writePackage("example-single", { bin: "./bin.js" });
    expect(resolvePackageBin(require, "example-single", "example-single")).toBe(
      join(dir, "bin.js"),
    );
  });

  it("throws when the package names no such bin, or is not installed", () => {
    writePackage("example-library", { main: "./index.js" });
    expect(() => resolvePackageBin(require, "example-library", "example-library")).toThrow(
      'The example-library package names no "example-library" bin.',
    );
    expect(() => resolvePackageBin(require, "example-tool", "missing")).toThrow(/no "missing" bin/);
    expect(() => resolvePackageBin(require, "example-not-installed", "x")).toThrow();
  });
});

describe("CLI_BIN", () => {
  it("is the orbitrace bin of the orbitrace package, which the root build writes", () => {
    const manifestPath = createRequire(import.meta.url).resolve(`${CLI_PACKAGE}/package.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };
    expect(manifest.name).toBe("orbitrace");
    expect(CLI_BIN).toBe(join(dirname(manifestPath), manifest.bin["orbitrace"]!));
    expect(existsSync(CLI_BIN), "run 'npm run build' at the root first").toBe(true);
  });
});
