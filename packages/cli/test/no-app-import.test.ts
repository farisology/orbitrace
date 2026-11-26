// #96: the CLI lists @orbitrace/app only as a dev dependency (to copy the built web app), so no
// file it ships may import the app or name it in a type. Reads only this package's own files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

function filesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));
}

const APP_IMPORT = /from\s+["']@orbitrace\/app(?:\/[^"']*)?["']|import\(["']@orbitrace\/app/;

describe("the CLI and @orbitrace/app", () => {
  it("keeps the app a dev dependency only", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).not.toHaveProperty("@orbitrace/app");
  });

  it("imports nothing from the app in its source", () => {
    const sources = filesUnder(join(packageDir, "src"), ".ts");
    expect(sources.length).toBeGreaterThan(0);
    const importing = sources.filter((file) => APP_IMPORT.test(readFileSync(file, "utf8")));
    expect(importing).toEqual([]);
  });

  it("names nothing from the app in its emitted declarations", () => {
    // `npm test` builds first; a bare `vitest run` in a fresh clone has no dist yet.
    const naming = filesUnder(join(packageDir, "dist"), ".d.ts").filter((file) =>
      readFileSync(file, "utf8").includes("@orbitrace/app"),
    );
    expect(naming).toEqual([]);
  });
});
