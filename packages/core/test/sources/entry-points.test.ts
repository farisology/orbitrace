// The browser entry of core must not reach a Node module; the Node code sits behind the
// `@orbitrace/core/node` subpath. Reads only this package's own source files.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as core from "../../src/index.js";
import * as nodeEntry from "../../src/sources/node.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every source file reachable from an entry through relative imports, and the bare imports seen. */
function walk(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith("."))
        pending.push(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
      else bare.add(specifier);
    }
    if (/reference types="node"/.test(text)) bare.add("node (types)");
  }
  return { files, bare };
}

describe("entry points", () => {
  it("keeps Node modules out of the main entry", () => {
    const { files, bare } = walk(join(packageDir, "src", "index.ts"));
    expect(files.has(join(packageDir, "src", "sources", "index.ts"))).toBe(true);
    expect([...bare]).toEqual([]);
  });

  it("exposes the adapter through the ./node subpath", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports["./node"]).toEqual({
      types: "./dist/sources/node.d.ts",
      default: "./dist/sources/node.js",
    });
    expect(walk(join(packageDir, "src", "sources", "node.ts")).bare.has("node:fs")).toBe(true);
  });

  it("exports the source functions from the right entries", () => {
    expect(typeof core.resolveSources).toBe("function");
    expect(typeof core.listSessions).toBe("function");
    expect(typeof core.toSessionSummary).toBe("function");
    expect(typeof core.describeResolution).toBe("function");
    expect("claudeCodeAdapter" in core).toBe(false);
    expect(nodeEntry.claudeCodeAdapter.runtime).toBe("claude-code");
    expect(typeof nodeEntry.createClaudeCodeAdapter).toBe("function");
  });

  it("exports the session replayer from ./node only, and its errors from both", () => {
    expect(typeof nodeEntry.createSessionReplayer).toBe("function");
    expect(typeof nodeEntry.createNodeSessionReplayer).toBe("function");
    expect("createSessionReplayer" in core).toBe(false);
    expect("createNodeSessionReplayer" in core).toBe(false);
    expect(typeof core.findSessionByKey).toBe("function");
    expect(typeof core.toRealSeconds).toBe("function");
    expect(core.SessionReplayError).toBe(nodeEntry.SessionReplayError);
    expect(core.TRANSPORT_ERROR_CODES).toContain("not-found");
  });

  it("re-exports the replayer's update types from the main entry, as types only (#84)", () => {
    expectTypeOf<core.SessionReplayUpdate>().toEqualTypeOf<nodeEntry.SessionReplayUpdate>();
    expectTypeOf<core.SessionReplayListener>().toEqualTypeOf<nodeEntry.SessionReplayListener>();
    // The re-export is `export type`, so the replayer's code stays off the main entry.
    const source = readFileSync(join(packageDir, "src", "index.ts"), "utf8");
    expect(source).toMatch(
      /export type \{ SessionReplayUpdate, SessionReplayListener \} from "\.\/host\/session-replayer\.js";/,
    );
    expect("createSessionReplayer" in core).toBe(false);
  });

  it("exports the session file watcher from ./node only (#74)", () => {
    expect(typeof nodeEntry.watchSessionFiles).toBe("function");
    expect(typeof nodeEntry.openNodeDirectoryWatcher).toBe("function");
    expect("watchSessionFiles" in core).toBe(false);
  });
});
