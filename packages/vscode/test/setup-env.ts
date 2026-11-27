/**
 * Runs before every test file of this package (vitest.config.mts `setupFiles`), before the file
 * imports anything: points HOME, USERPROFILE, CLAUDE_CONFIG_DIR and ORBITRACE_DATA_DIR at new
 * temporary folders (#211). The extension reads the history switch at activation, so without this
 * a test could read the real home folder's settings; with it, nothing reads the real ~/.claude and
 * no real ~/.orbitrace is ever created. The data folder itself is not created here: tests check
 * that the extension does not create it while recording is off.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "ORBITRACE_DATA_DIR"] as const;
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
const base = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-vscode-env-")));
const home = join(base, "home");
const config = join(base, "config");
mkdirSync(home, { recursive: true });
mkdirSync(config, { recursive: true });
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
process.env["CLAUDE_CONFIG_DIR"] = config;
process.env["ORBITRACE_DATA_DIR"] = join(base, "data");

afterAll(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});
