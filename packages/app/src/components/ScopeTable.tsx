/**
 * What the orrery canvas shows, as a table a screen reader can move through: one row per agent
 * with its model family and shape, who started it, whether it is running at the playhead and its
 * tool calls so far. Visually hidden; sighted users read the canvas, the timeline and the
 * inspector instead.
 *
 * It is not a live region, so it never announces by itself. It re-renders only when the playhead
 * crosses a moment at which a row changes (`scopeChangeTimes`), not on every frame.
 */

import { useCallback, useMemo } from "react";
import type { ReplayAgentId, ReplayModel } from "@orbitrace/core";
import { countAtOrBefore, type ClockState } from "../clock";
import { formatCount } from "../format";
import { SCOPE_PHASE_LABELS, scopeChangeTimes, scopeRows, scopeSummary } from "../scope-text";
import { useClockValue } from "../use-clock";

export interface ScopeTableProps {
  readonly model: ReplayModel;
  readonly selected: ReplayAgentId | null;
  /** Id of the table, so the canvas can point at it. */
  readonly id: string;
}

export function ScopeTable({ model, selected, id }: ScopeTableProps) {
  const moments = useMemo(() => scopeChangeTimes(model), [model]);
  const items = useMemo(() => moments.map(asItem), [moments]);
  const selectStep = useCallback(
    (state: ClockState) => countAtOrBefore(items, state.time),
    [items],
  );
  const step = useClockValue(selectStep);
  // Any time in [moments[step - 1], moments[step]) gives the same rows.
  const at = step === 0 ? -Infinity : (moments[step - 1] ?? -Infinity);
  const rows = useMemo(() => scopeRows(model, at, selected), [model, at, selected]);

  return (
    // The wrapper hides it: a table ignores a 1 px width and would widen the page.
    <div className="visually-hidden">
      <table id={id}>
        <caption>Agents in the orrery at the playhead: {scopeSummary(rows)}</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Model family and shape</th>
            <th scope="col">Started by</th>
            <th scope="col">State</th>
            <th scope="col">Tool calls so far</th>
            <th scope="col">Calls running</th>
            <th scope="col">Failed calls so far</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">
                {row.callsign}
                {row.selected ? ", selected" : ""}
              </th>
              <td>{row.family}</td>
              <td>{row.parent ?? "none, main agent"}</td>
              <td>{SCOPE_PHASE_LABELS[row.phase]}</td>
              <td>{formatCount(row.calls)}</td>
              <td>{formatCount(row.running)}</td>
              <td>{formatCount(row.failed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function asItem(t: number): { readonly t: number } {
  return { t };
}
