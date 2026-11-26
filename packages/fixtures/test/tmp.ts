/** Temporary folders for tests that write fixture files. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/** A new empty folder under the system's temporary folder. */
export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbitrace-fixtures-"));
  created.push(dir);
  return dir;
}

/** Remove every folder makeTempDir created. Call from afterEach. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
