/// <reference types="node" />
/**
 * Hold back Node's "SQLite is an experimental feature" warning (#188, #195).
 *
 * Node 22.x and 23.x print one `ExperimentalWarning` the first time `node:sqlite` is loaded in a
 * process or worker thread; Node 24 and later print none (docs/decisions/0001-storage.md). A host
 * that loads the history engine for its user (the CLI, the history worker) runs the first load
 * inside `withoutSqliteWarning`, so that line does not reach the user's terminal. Every other
 * warning passes through unchanged.
 *
 * Node only. Exported from `@orbitrace/core/node` through `history/index.ts`.
 */

/** Whether a warning is the SQLite experimental warning. */
export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
  const text = warning instanceof Error ? `${warning.name} ${warning.message}` : String(warning);
  const first = rest[0];
  const type =
    typeof first === "string"
      ? first
      : typeof first === "object" && first !== null
        ? String((first as { type?: unknown }).type ?? "")
        : "";
  return /sqlite/i.test(text) && (/Experimental/.test(type) || /Experimental/.test(text));
}

/**
 * Run `body` with the SQLite experimental warning held back. `process.emitWarning` is restored
 * when `body` settles, whether it resolves or throws.
 */
export async function withoutSqliteWarning<T>(body: () => Promise<T>): Promise<T> {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await body();
  } finally {
    process.emitWarning = original;
  }
}
