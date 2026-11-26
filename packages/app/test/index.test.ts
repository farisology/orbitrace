// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index";
import * as protocol from "../src/protocol";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("@orbitrace/app entry", () => {
  it("exports the wire layout for the hosts, and not the React app", () => {
    expect(Object.keys(entry).sort()).toEqual(Object.keys(protocol).sort());
    expect(entry.RPC_PATH).toBe("/api/rpc");
    expect(typeof entry.parseTransportRequest).toBe("function");
    expect(entry).not.toHaveProperty("App");
  });

  it("points package.json exports at the built entry, the transport types and the bundle", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/types/index.d.ts", default: "./dist/types/index.js" },
      "./transport": { types: "./dist/types/transport.d.ts" },
      "./dist/*": "./dist/*",
      "./package.json": "./package.json",
    });
  });

  it("is importable as plain JavaScript once built", async () => {
    const built = join(packageDir, "dist", "types", "index.js");
    // `npm test` builds first; a bare `vitest run` in a fresh clone has nothing to import yet.
    if (!existsSync(built)) return;
    const module = (await import(built)) as typeof entry;
    expect(Object.keys(module).sort()).toEqual(Object.keys(protocol).sort());
    expect(module.readHostFragment("#t=abc&key=k")).toEqual({ token: "abc", sessionKey: "k" });
  });
});
