/**
 * The `orbitrace doctor` report (#31): its checks, their stable codes, the JSON document and the
 * text for the terminal. docs/cli.md lists the same checks and codes; a test checks that the two
 * agree.
 */

import { sanitizeForTerminal } from "../output.js";

/** The outcome of one check. */
export const DOCTOR_STATUSES = ["ok", "warn", "fail", "skipped"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

/** Every check, in the order the report lists them. */
export const DOCTOR_CHECK_IDS = [
  "node-version",
  "config-folder",
  "session-roots",
  "parser",
  "running-registry",
  "app-bundle",
  "loopback-port",
  "history-store",
  "hooks",
  "remote-sources",
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/**
 * The stable codes of each check. A code names one finding; the status that goes with it is in
 * docs/cli.md. `check-error` is shared: a check that could not run at all.
 */
export const DOCTOR_CODES = {
  "node-version": ["node-version-ok", "node-version-unsupported", "node-version-range-unknown"],
  "config-folder": [
    "config-folder-ok",
    "config-folder-env-invalid",
    "config-folder-no-home",
    "config-folder-missing",
    "config-folder-not-a-folder",
    "config-folder-unreadable",
    "config-folder-projects-not-a-folder",
    "config-folder-no-projects",
  ],
  "session-roots": [
    "session-roots-ok",
    "session-roots-none",
    "session-roots-unavailable",
    "session-roots-config-dir-unavailable",
    "session-roots-empty",
  ],
  parser: ["parser-ok", "parser-malformed-lines", "parser-unreadable", "parser-no-sessions"],
  "running-registry": [
    "running-registry-ok",
    "running-registry-missing",
    "running-registry-not-a-folder",
    "running-registry-unreadable",
    "running-registry-no-roots",
  ],
  "app-bundle": ["app-bundle-ok", "app-bundle-missing", "app-bundle-incomplete"],
  "loopback-port": ["loopback-port-ok", "loopback-port-unavailable"],
  "history-store": [
    "history-store-available",
    "history-store-not-in-use",
    "history-store-unavailable",
    "history-store-settings-invalid",
  ],
  hooks: ["hooks-not-built"],
  "remote-sources": ["remote-sources-not-built"],
} as const satisfies Record<DoctorCheckId, readonly string[]>;

/** The code of a check that threw instead of reporting. Its status is `fail`. */
export const CHECK_ERROR_CODE = "check-error";

export type DoctorCode = (typeof DOCTOR_CODES)[DoctorCheckId][number] | typeof CHECK_ERROR_CODE;

/** Every code, in check order, `check-error` last. */
export const ALL_DOCTOR_CODES: readonly DoctorCode[] = [
  ...DOCTOR_CHECK_IDS.flatMap((id) => DOCTOR_CODES[id]),
  CHECK_ERROR_CODE,
];

/** One check's result. `fix` is set for every `warn` and `fail`, and `null` otherwise. */
export interface DoctorCheckResult {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly code: DoctorCode;
  /** One line. Shows no path except a folder path with the home folder as `~`. */
  readonly message: string;
  /** A command to run or a setting to change. */
  readonly fix: string | null;
  /** Check-specific facts; their keys are listed in docs/cli.md. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** Version of the report's JSON shape. Raised when a field is removed or changes meaning. */
export const DOCTOR_FORMAT_VERSION = 1;

/** The document `orbitrace doctor --json` writes. */
export interface DoctorReport {
  readonly doctor: typeof DOCTOR_FORMAT_VERSION;
  /** Version of the `orbitrace` command. */
  readonly orbitrace: string;
  /** Version of Node running the command. */
  readonly node: string;
  /** As in `process.platform`. */
  readonly platform: string;
  /** `fail` when a check failed, else `warn` when one warned, else `ok`. */
  readonly status: "ok" | "warn" | "fail";
  readonly summary: Readonly<Record<DoctorStatus, number>>;
  readonly checks: readonly DoctorCheckResult[];
}

/** The overall status and the number of checks with each status. */
export function summarize(checks: readonly DoctorCheckResult[]): {
  status: DoctorReport["status"];
  summary: Record<DoctorStatus, number>;
} {
  const summary: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) summary[check.status] += 1;
  const status = summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "ok";
  return { status, summary };
}

const STATUS_LABEL: Readonly<Record<DoctorStatus, string>> = {
  ok: "ok",
  warn: "warn",
  fail: "FAIL",
  skipped: "skip",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The report as text for the terminal: one line per check, a fix line under each problem. */
export function formatDoctorText(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.id.length));
  const lines = [
    `orbitrace doctor: orbitrace ${report.orbitrace}, Node ${report.node}, ${report.platform}. Reads only; changes nothing.`,
    "",
  ];
  for (const check of report.checks) {
    const label = STATUS_LABEL[check.status].padEnd(4);
    const code = check.status === "warn" || check.status === "fail" ? ` [${check.code}]` : "";
    lines.push(`${label}  ${check.id.padEnd(width)}  ${sanitizeForTerminal(check.message)}${code}`);
    if (check.fix !== null) {
      lines.push(`${" ".repeat(4 + 2 + width + 2)}fix: ${sanitizeForTerminal(check.fix)}`);
    }
  }
  const { summary } = report;
  lines.push(
    "",
    `Result: ${report.status} (${plural(summary.fail, "failed", "failed")}, ` +
      `${plural(summary.warn, "warning", "warnings")}, ${summary.ok} ok, ${summary.skipped} skipped).`,
    "Run 'orbitrace doctor --json' for the codes and details.",
  );
  return `${lines.join("\n")}\n`;
}
