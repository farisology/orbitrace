#!/usr/bin/env node
/**
 * Writes or checks the committed golden replay files.
 *
 *   node dist/goldens-cli.js            rewrite fixtures/replays/<scenario>.replay.json
 *   node dist/goldens-cli.js --check    exit 1 when a golden differs from the pipeline
 *   --fixtures <dir>                    use another fixtures folder (manifest.json and config/)
 *
 * The goldens are the output of the replay pipeline of @orbitrace/core over the transcripts in
 * the fixtures folder. Build the workspace first (npm run build at the repository root), so
 * that the pipeline that runs is the one in the source.
 */
import { isEntryPoint, type CliIo } from "./entry.js";
import {
  GOLDENS_COMMAND,
  checkGoldenReplays,
  describeGoldenReplayDiff,
  isGoldenReplaysCurrent,
  writeGoldenReplays,
} from "./goldens.js";
import { FIXTURES_DIR } from "./paths.js";

const USAGE = "usage: node dist/goldens-cli.js [--check] [--fixtures <dir>]";

interface GoldensCliArguments {
  check: boolean;
  fixtures: string;
}

function parseArguments(argv: readonly string[]): GoldensCliArguments {
  const parsed: GoldensCliArguments = { check: false, fixtures: FIXTURES_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      parsed.check = true;
    } else if (argument === "--fixtures") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--fixtures needs a value");
      parsed.fixtures = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
  }
  return parsed;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the command. Returns the exit status: 0 done, 1 the goldens differ or could not be
 * built, 2 bad usage.
 */
export async function runGoldensCli(argv: readonly string[], io: CliIo = console): Promise<number> {
  let options: GoldensCliArguments;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io.error(`goldens: ${reason(error)}`);
    io.error(USAGE);
    return 2;
  }
  try {
    if (options.check) {
      const diff = await checkGoldenReplays(options.fixtures);
      if (isGoldenReplaysCurrent(diff)) {
        io.log("golden replays match the pipeline");
        return 0;
      }
      for (const line of describeGoldenReplayDiff(diff)) io.error(line);
      io.error(
        `golden replays differ from the pipeline. If the change is intended, run: ${GOLDENS_COMMAND}`,
      );
      return 1;
    }
    const written = await writeGoldenReplays(options.fixtures);
    io.log(`wrote ${written.length} golden replay file(s)`);
    return 0;
  } catch (error) {
    io.error(`goldens: ${reason(error)}`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await runGoldensCli(process.argv.slice(2));
}
