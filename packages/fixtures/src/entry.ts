/** Shared by the command-line files of this package. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where a command writes its lines. `console` fits. */
export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

/**
 * True when the module at `moduleUrl` (its `import.meta.url`) is the file Node was started
 * with. `entry` is the path Node was given; it defaults to `process.argv[1]`.
 */
export function isEntryPoint(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
