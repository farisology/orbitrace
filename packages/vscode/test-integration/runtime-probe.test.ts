import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  describeRuntime,
  parseRuntimeProbe,
  probeEditorRuntime,
  probeEnvironment,
  RUNTIME_PROBE_MARKER,
  RUNTIME_PROBE_SCRIPT,
  type EditorRuntime,
} from "./runtime-probe.js";

const LOADED = {
  node: "24.22.1",
  electron: "43.8.10",
  sqlite: "3.53.4",
  modules: "148",
  nodeSqlite: true,
  sqliteVersion: "3.53.4",
  fts5: true,
  error: null,
};

const MISSING = {
  node: "20.18.1",
  electron: "32.2.6",
  sqlite: null,
  modules: "128",
  nodeSqlite: false,
  sqliteVersion: null,
  fts5: null,
  error: "ERR_UNKNOWN_BUILTIN_MODULE",
};

const line = (value: unknown): string => `${RUNTIME_PROBE_MARKER}${JSON.stringify(value)}`;

/** Whether this Node can require node:sqlite, as the probe does. */
function nodeSqliteLoads(): boolean {
  try {
    createRequire(import.meta.url)(["node", "sqlite"].join(":"));
    return true;
  } catch {
    return false;
  }
}

describe("parseRuntimeProbe", () => {
  it("reads the marked line among other output, with Windows line ends too", () => {
    expect(parseRuntimeProbe(`noise\r\n${line(LOADED)}\r\nmore\r\n`)).toEqual({
      ...LOADED,
      experimentalWarning: false,
    });
    expect(parseRuntimeProbe(line(MISSING))).toEqual({ ...MISSING, experimentalWarning: false });
  });

  it("notes Node's ExperimentalWarning from stderr", () => {
    const stderr = "(node:1) ExperimentalWarning: SQLite is an experimental feature";
    expect(parseRuntimeProbe(line(LOADED), stderr)?.experimentalWarning).toBe(true);
  });

  it("returns null without the marker, for broken JSON, and for values of the wrong type", () => {
    expect(parseRuntimeProbe("")).toBeNull();
    expect(parseRuntimeProbe(JSON.stringify(LOADED))).toBeNull();
    expect(parseRuntimeProbe(`${RUNTIME_PROBE_MARKER}{not json`)).toBeNull();
    expect(parseRuntimeProbe(`${RUNTIME_PROBE_MARKER}null`)).toBeNull();
    expect(parseRuntimeProbe(line({ ...LOADED, node: 24 }))).toBeNull();
    expect(parseRuntimeProbe(line({ ...LOADED, nodeSqlite: "yes" }))).toBeNull();
    expect(parseRuntimeProbe(line({ ...LOADED, fts5: "no" }))).toBeNull();
    expect(parseRuntimeProbe(line({ ...LOADED, error: 1 }))).toBeNull();
  });
});

describe("describeRuntime", () => {
  it("names the versions and whether node:sqlite loads, with FTS5 and the warning", () => {
    const loaded: EditorRuntime = { ...LOADED, experimentalWarning: true };
    expect(describeRuntime(loaded)).toBe(
      "Node 24.22.1, Electron 43.8.10, SQLite in process.versions 3.53.4, node:sqlite loads (SQLite 3.53.4, FTS5 yes, ExperimentalWarning)",
    );
    expect(describeRuntime({ ...MISSING, electron: null, experimentalWarning: false })).toBe(
      "Node 20.18.1, Electron (none), SQLite in process.versions (none), node:sqlite does not load (ERR_UNKNOWN_BUILTIN_MODULE)",
    );
  });
});

describe("probeEnvironment", () => {
  it("drops an outer editor's variables, keeps the rest and runs the binary as Node", () => {
    expect(
      probeEnvironment({
        PATH: "/usr/bin",
        VSCODE_IPC_HOOK: "/tmp/other.sock",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        EMPTY: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
  });
});

describe("probeEditorRuntime", () => {
  it("probes a Node binary the same way as an editor binary", () => {
    // Plain Node ignores ELECTRON_RUN_AS_NODE and runs the script, like an editor binary does.
    const runtime = probeEditorRuntime(process.execPath);
    expect(runtime.node).toBe(process.versions.node);
    expect(runtime.electron).toBeNull();
    expect(runtime.nodeSqlite).toBe(nodeSqliteLoads());
    if (runtime.nodeSqlite) {
      expect(runtime.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
      expect(typeof runtime.fts5).toBe("boolean");
    } else {
      expect(runtime.error).toBe("ERR_UNKNOWN_BUILTIN_MODULE");
    }
  });

  it("throws when the binary prints no result", () => {
    expect(() => probeEditorRuntime(join(tmpdir(), `oti-no-such-editor-${process.pid}`))).toThrow(
      /printed no result/,
    );
  });

  it("uses a script that prints no path", () => {
    expect(RUNTIME_PROBE_SCRIPT).not.toMatch(/execPath|argv|cwd|__dirname|homedir/);
  });
});
