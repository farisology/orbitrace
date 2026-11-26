#!/usr/bin/env node
/**
 * Writes or checks the committed fixtures.
 *
 *   node dist/cli.js            write fixtures/ at the repository root
 *   node dist/cli.js --check    exit 1 when fixtures/ differs from the generator
 *   --out <dir>                 use another folder
 *   --seed <seed>               use another seed (never for the committed set)
 *
 * The golden replay files beside them have their own command: see goldens-cli.ts.
 */
import { isEntryPoint, type CliIo } from "./entry.js";
import { DEFAULT_SEED } from "./generator.js";
import { FIXTURES_DIR } from "./paths.js";
import { checkFixtureTree, isFixtureTreeCurrent, writeFixtureTree } from "./write.js";

export type { CliIo };

interface CliArguments {
  check: boolean;
  out: string;
  seed: string;
}

function parseArguments(argv: readonly string[]): CliArguments {
  const parsed: CliArguments = { check: false, out: FIXTURES_DIR, seed: DEFAULT_SEED };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      parsed.check = true;
    } else if (argument === "--out" || argument === "--seed") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === "--out") parsed.out = value;
      else parsed.seed = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
  }
  return parsed;
}

/** Run the command. Returns the exit status: 0 done, 1 fixtures differ, 2 bad usage. */
export function runCli(argv: readonly string[], io: CliIo = console): number {
  let options: CliArguments;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io.error(`fixtures: ${error instanceof Error ? error.message : String(error)}`);
    io.error("usage: node dist/cli.js [--check] [--out <dir>] [--seed <seed>]");
    return 2;
  }
  if (options.check) {
    const diff = checkFixtureTree(options.out, { seed: options.seed });
    for (const path of diff.missing) io.error(`missing: ${path}`);
    for (const path of diff.changed) io.error(`changed: ${path}`);
    for (const path of diff.extra) io.error(`not generated: ${path}`);
    if (!isFixtureTreeCurrent(diff)) {
      io.error("fixtures differ from the generator. Run: npm run generate -w @orbitrace/fixtures");
      return 1;
    }
    io.log("fixtures match the generator");
    return 0;
  }
  const written = writeFixtureTree(options.out, { seed: options.seed });
  io.log(`wrote ${written.length} fixture file(s) with seed "${options.seed}"`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
