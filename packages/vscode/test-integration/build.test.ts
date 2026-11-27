import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { integrationBuildOptions } from "./build.mjs";

describe("integrationBuildOptions", () => {
  const dir = join("/repo", "packages", "vscode", "test-integration");
  const { suite, launcher } = integrationBuildOptions(dir);

  it("bundles the suite as CommonJS for the extension host, with vscode left out", () => {
    expect(suite.entryPoints).toEqual([join(dir, "suite.ts")]);
    expect(suite.outfile).toBe(join(dir, "dist", "suite.cjs"));
    expect(suite.format).toBe("cjs");
    expect(suite.external).toEqual(["vscode"]);
    expect(suite.bundle).toBe(true);
  });

  it("keeps the suite inside the package folder, so it gets the extension's API object", () => {
    expect(suite.absWorkingDir).toBe(join("/repo", "packages", "vscode"));
    expect(String(suite.outfile).startsWith(join("/repo", "packages", "vscode"))).toBe(true);
  });

  it("bundles the launcher as an ES module with packages loaded from node_modules", () => {
    expect(launcher.entryPoints).toEqual([join(dir, "run.ts")]);
    expect(launcher.outfile).toBe(join(dir, "dist", "run.mjs"));
    expect(launcher.format).toBe("esm");
    expect(launcher.packages).toBe("external");
  });

  it("writes no source maps, which would carry build paths", () => {
    expect(suite.sourcemap).toBe(false);
    expect(launcher.sourcemap).toBe(false);
  });
});
