/**
 * `orbitrace doctor` (#31): run every check once and report what is wrong and how to fix it.
 * Reads only. Exits with 0 when no check failed and with `doctor-failed` (12) when one did; in
 * both cases the report is written to stdout (one JSON document with `--json`).
 */

import { listSessions, type SessionRef, type SourceAdapter } from "@orbitrace/core";
import type { HistoryCapability } from "@orbitrace/core/node";
import type { ParsedCommand, SourceFlags } from "../args.js";
import { CLI_EXIT_CODES, EXIT_OK } from "../errors.js";
import { CLI_ADAPTERS, resolveRoots, type HostContext, type ResolvedRoots } from "../sessions.js";
import { cliNodeRange, cliVersion } from "../version.js";
import {
  check,
  checkAppBundleFinding,
  checkConfigFolder,
  checkHistoryStore,
  checkHooks,
  checkLoopbackPort,
  checkNodeVersion,
  checkParser,
  checkRemoteSources,
  checkRunningRegistry,
  checkSessionRoots,
  readRecordingState,
} from "./checks.js";
import { rootPathShower, type PathShower } from "./paths.js";
import {
  DOCTOR_FORMAT_VERSION,
  formatDoctorText,
  summarize,
  type DoctorCheckResult,
  type DoctorReport,
} from "./report.js";

/** What the doctor reads from the process. Every field has a default; tests replace them. */
export interface DoctorRuntime {
  /** Default: `process.versions.node`. */
  readonly nodeVersion?: string;
  /** The supported range. Default: `engines.node` of this package (`null` when it has none). */
  readonly nodeRange?: string | null;
  /** The web app folder. Default: `dist/app` beside the command. `null` means none. */
  readonly appDir?: string | null;
  /** Whether the history store can run here. Default: core's `historyCapability()`, quietly. */
  readonly historyCapability?: () => Promise<HistoryCapability>;
  /** Listens on a free port of 127.0.0.1 and closes it. Default: `bindLoopbackPort`. */
  readonly bindLoopback?: () => Promise<void>;
  /** Source adapters. Default: the ones `list` uses. */
  readonly adapters?: readonly SourceAdapter[];
}

export interface DoctorOptions {
  readonly host: HostContext;
  readonly sources: SourceFlags;
  /** Most sessions the parser check reads, newest first. */
  readonly parseLimit: number;
  readonly runtime?: DoctorRuntime;
}

/** Run every check and build the report. Never throws: a check that throws is a `fail`. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { host, sources, parseLimit } = options;
  const runtime = options.runtime ?? {};
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  const adapters = runtime.adapters ?? CLI_ADAPTERS;

  // The same resolution `list` uses; shared by the checks that need folders or sessions.
  let resolved: ResolvedRoots | null = null;
  let sessions: readonly SessionRef[] = [];
  let listingError = false;
  try {
    resolved = await resolveRoots(host, sources, adapters);
    sessions = await listSessions(resolved.roots, adapters);
  } catch {
    listingError = true;
  }
  // One path display for every check that shows a session folder: a relative --config-dir
  // value stays relative to the working folder.
  const showFor = (value: ResolvedRoots): PathShower =>
    rootPathShower(host, value.roots, sources.configDirs);
  const needsListing = <T>(run: (value: ResolvedRoots) => T): (() => T) => {
    return () => {
      if (listingError || resolved === null) throw new Error("listing failed");
      return run(resolved);
    };
  };

  const checks: DoctorCheckResult[] = [
    await check("node-version", () =>
      checkNodeVersion(
        nodeVersion,
        runtime.nodeRange === undefined ? cliNodeRange() : runtime.nodeRange,
      ),
    ),
    await check("config-folder", () => checkConfigFolder(host, resolved?.roots ?? [])),
    await check(
      "session-roots",
      needsListing((value) =>
        checkSessionRoots(host, value.roots, value.warnings, sessions, showFor(value)),
      ),
    ),
    await check(
      "parser",
      needsListing((value) => checkParser(host, sessions, parseLimit, adapters, showFor(value))),
    ),
    await check(
      "running-registry",
      needsListing((value) => checkRunningRegistry(host, value.roots, showFor(value))),
    ),
    await check("app-bundle", () =>
      runtime.appDir === undefined
        ? checkAppBundleFinding()
        : checkAppBundleFinding(runtime.appDir),
    ),
    await check("loopback-port", () => checkLoopbackPort(runtime.bindLoopback)),
    await check("history-store", () =>
      checkHistoryStore(nodeVersion, runtime.historyCapability, readRecordingState(host)),
    ),
    await check("hooks", checkHooks),
    await check("remote-sources", checkRemoteSources),
  ];
  const { status, summary } = summarize(checks);
  return {
    doctor: DOCTOR_FORMAT_VERSION,
    orbitrace: cliVersion(),
    node: nodeVersion,
    platform: host.platform,
    status,
    summary,
    checks,
  };
}

/** The exit code for a report: 0, or `doctor-failed` when a check failed. */
export function doctorExitCode(report: DoctorReport): number {
  return report.status === "fail" ? CLI_EXIT_CODES["doctor-failed"] : EXIT_OK;
}

/** Where the command writes. The same shape as `CliIo` in cli.ts. */
export interface DoctorIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Run `orbitrace doctor` and write its report. Resolves with the exit code. */
export async function runDoctorCommand(
  command: Extract<ParsedCommand, { kind: "doctor" }>,
  io: DoctorIo,
  host: HostContext,
  runtime: DoctorRuntime = {},
): Promise<number> {
  const report = await runDoctor({
    host,
    sources: command.sources,
    parseLimit: command.parseLimit,
    runtime,
  });
  io.stdout(command.json ? `${JSON.stringify(report)}\n` : formatDoctorText(report));
  return doctorExitCode(report);
}
