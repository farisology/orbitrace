/**
 * How a tool call is drawn on a timeline lane. Each kind has its own colour and also its own
 * height and position in the lane, so colour is not the only sign of the kind (WCAG 1.4.1):
 * shell calls sit at the top, read, MCP and other calls in the middle, edits at the bottom,
 * agent calls are tall, and failed calls fill the whole lane. The legend in the timeline and the
 * kind table in the inspector draw the same marks.
 */

import type { ToolKind } from "@orbitrace/core";
import { KIND_LABELS } from "../agent-stats";

/** Height of a lane track in drawing units; every band below fits inside it. */
export const CALL_TRACK_UNITS = 10;

/** Vertical position and height of a call mark, in drawing units of a 10-unit track. */
export interface CallBand {
  readonly y: number;
  readonly height: number;
}

/** A failed call of any kind: the only mark that fills the whole lane. */
export const FAILED_CALL_BAND: CallBand = { y: 0, height: 10 };

/** The band of each kind of call that did not fail. */
export const CALL_BANDS: Readonly<Record<ToolKind, CallBand>> = {
  shell: { y: 0.5, height: 4 },
  read: { y: 3, height: 4 },
  mcp: { y: 3, height: 4 },
  other: { y: 3, height: 4 },
  edit: { y: 5.5, height: 4 },
  agent: { y: 1.5, height: 7 },
};

/** Where a call of `kind` is drawn on its lane. */
export function callBand(kind: ToolKind, failed: boolean): CallBand {
  return failed ? FAILED_CALL_BAND : CALL_BANDS[kind];
}

/** CSS class that colours a call: by kind, or the failure colour. */
export function callClass(kind: ToolKind, failed: boolean): string {
  return failed ? "call call-failed" : `call k-${kind}`;
}

/** One entry of the timeline legend. */
export interface LegendEntry {
  readonly label: string;
  readonly kind: ToolKind;
  readonly failed: boolean;
}

/**
 * The legend, one entry per distinct mark: read, MCP and other share a mark, so they share an
 * entry. Failed calls are last.
 */
export const CALL_LEGEND: readonly LegendEntry[] = [
  { label: KIND_LABELS.shell, kind: "shell", failed: false },
  {
    label: `${KIND_LABELS.read}, ${KIND_LABELS.mcp}, ${KIND_LABELS.other}`,
    kind: "read",
    failed: false,
  },
  { label: KIND_LABELS.edit, kind: "edit", failed: false },
  { label: KIND_LABELS.agent, kind: "agent", failed: false },
  { label: "Failed", kind: "other", failed: true },
];

export interface CallMarkProps {
  readonly kind: ToolKind;
  readonly failed?: boolean;
}

/**
 * A sample of the mark a call of `kind` gets on a lane, drawn over a piece of the lifetime bar at
 * the same height and colour. Decorative: it always sits beside the kind's name in words.
 */
export function CallMark({ kind, failed = false }: CallMarkProps) {
  const band = callBand(kind, failed);
  return (
    <svg
      className="call-mark"
      viewBox={`0 0 12 ${CALL_TRACK_UNITS}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="lane-life" x={0} y={3.5} width={12} height={3} />
      <rect className={callClass(kind, failed)} x={3} y={band.y} width={6} height={band.height} />
    </svg>
  );
}
