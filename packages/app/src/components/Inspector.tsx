/**
 * Details of the selected agent: callsign, model family, effort, wave, start and end, token
 * classes and tool calls by kind with failures. With nothing selected it shows the session
 * totals. All times are real time (idle gaps included), converted with `toRealSeconds`.
 */

import { useCallback, useRef } from "react";
import {
  toRealSeconds,
  type ReplayAgent,
  type ReplayAgentId,
  type ReplayModel,
  type ReplayTotals,
} from "@orbitrace/core";
import {
  KIND_LABELS,
  agentPhase,
  familyLabel,
  familyShape,
  findAgent,
  toolCallsByKind,
  waveLabel,
  type AgentPhase,
} from "../agent-stats";
import type { ClockState } from "../clock";
import { formatClock, formatCount, formatDuration } from "../format";
import { useClockValue } from "../use-clock";
import { CallMark } from "./CallMark";

const PHASE_LABELS: Readonly<Record<AgentPhase, string>> = {
  waiting: "Not started",
  running: "Running",
  finished: "Finished",
};

function TokenTable({ totals, caption }: { totals: ReplayTotals; caption: string }) {
  const rows: [string, number][] = [
    ["Input", totals.inputTokens],
    ["Output", totals.outputTokens],
    ["Cache read", totals.cacheReadTokens],
    ["Cache creation", totals.cacheCreationTokens],
  ];
  return (
    <table className="stat-table">
      <caption>{caption}</caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{formatCount(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KindTable({ agent }: { agent: ReplayAgent }) {
  const kinds = toolCallsByKind(agent);
  if (kinds.length === 0) return <p className="muted">No tool calls.</p>;
  return (
    <table className="stat-table kind-table">
      <caption>Tool calls by kind</caption>
      <thead>
        <tr>
          <th scope="col">Kind</th>
          <th scope="col">Calls</th>
          <th scope="col">Failed</th>
        </tr>
      </thead>
      <tbody>
        {kinds.map((entry) => (
          <tr key={entry.kind}>
            <th scope="row">
              <CallMark kind={entry.kind} />
              {KIND_LABELS[entry.kind]}
            </th>
            <td>{formatCount(entry.calls)}</td>
            <td className={entry.failed > 0 ? "fault" : undefined}>{formatCount(entry.failed)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total</th>
          <td>{formatCount(agent.totals.toolCalls)}</td>
          <td className={agent.totals.failedToolCalls > 0 ? "fault" : undefined}>
            {formatCount(agent.totals.failedToolCalls)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function AgentDetails({ model, agent }: { model: ReplayModel; agent: ReplayAgent }) {
  const selectPhase = useCallback((state: ClockState) => agentPhase(agent, state.time), [agent]);
  const phase = useClockValue(selectPhase);
  const realStart = toRealSeconds(model.warps, agent.start);
  const realEnd = agent.end === null ? null : toRealSeconds(model.warps, agent.end);
  const parent = agent.parent === null ? null : findAgent(model, agent.parent);
  return (
    <>
      <div className="inspector-head">
        <h3 className="callsign">{agent.callsign}</h3>
        <span className={`phase phase-${phase}`}>{PHASE_LABELS[phase]}</span>
      </div>
      <dl className="facts">
        <dt>Agent type</dt>
        <dd>{agent.name}</dd>
        <dt>Model family</dt>
        <dd>
          {familyLabel(agent.family)} <span className="muted">({familyShape(agent.family)})</span>
        </dd>
        <dt>Model</dt>
        <dd>{agent.model ?? "not recorded"}</dd>
        <dt>Effort</dt>
        <dd>{agent.effort ?? "not recorded"}</dd>
        <dt>Wave</dt>
        <dd>{waveLabel(agent.wave)}</dd>
        {parent !== undefined && parent !== null ? (
          <>
            <dt>Started by</dt>
            <dd>{parent.callsign}</dd>
          </>
        ) : null}
        <dt>Start</dt>
        <dd>{formatClock(realStart)}</dd>
        <dt>End</dt>
        <dd>{realEnd === null ? "still running" : formatClock(realEnd)}</dd>
        {realEnd !== null ? (
          <>
            <dt>Ran for</dt>
            <dd>{formatDuration(realEnd - realStart)}</dd>
          </>
        ) : null}
        <dt>Replies</dt>
        <dd>{formatCount(agent.totals.replies)}</dd>
      </dl>
      <TokenTable totals={agent.totals} caption="Tokens" />
      <KindTable agent={agent} />
    </>
  );
}

function SessionDetails({ model }: { model: ReplayModel }) {
  const { totals } = model;
  return (
    <>
      <p className="muted">Select an agent in the orrery or on a timeline lane to inspect it.</p>
      <dl className="facts">
        <dt>Agents</dt>
        <dd>{formatCount(totals.agents)}</dd>
        <dt>Tool calls</dt>
        <dd>{formatCount(totals.toolCalls)}</dd>
        <dt>Failed calls</dt>
        <dd className={totals.failedToolCalls > 0 ? "fault" : undefined}>
          {formatCount(totals.failedToolCalls)}
        </dd>
        <dt>Replies</dt>
        <dd>{formatCount(totals.replies)}</dd>
        <dt>Real length</dt>
        <dd>{formatDuration(totals.realDuration)}</dd>
        <dt>Idle cut</dt>
        <dd>{formatDuration(totals.realDuration - totals.duration)}</dd>
      </dl>
      <TokenTable totals={totals} caption="Session tokens" />
    </>
  );
}

/**
 * Id of the inspector heading. It takes focus (tabindex -1) when the selection is cleared from
 * the inspector, so focus does not drop to the page when the Clear selection button goes away.
 */
export const INSPECTOR_HEADING_ID = "inspector-title";

/** Class of the Clear selection button, so the Escape shortcut can tell it had focus. */
export const CLEAR_SELECTION_CLASS = "clear-selection";

export interface InspectorProps {
  readonly model: ReplayModel;
  readonly selected: ReplayAgentId | null;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
}

export function Inspector({ model, selected, onSelect }: InspectorProps) {
  const agent = findAgent(model, selected);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The inspector scrolls on its own when the window is short. tabIndex 0 makes it a Tab stop,
  // so a keyboard user can scroll it with the arrow and Page keys even when nothing inside can
  // take focus (no agent selected) and in browsers that do not focus scroll areas themselves.
  return (
    <section className="panel inspector" aria-labelledby={INSPECTOR_HEADING_ID} tabIndex={0}>
      <div className="panel-head">
        <h2 id={INSPECTOR_HEADING_ID} ref={headingRef} tabIndex={-1}>
          {agent === undefined ? "Session" : "Agent"}
        </h2>
        {agent !== undefined ? (
          <button
            type="button"
            className={`link-button ${CLEAR_SELECTION_CLASS}`}
            onClick={() => {
              headingRef.current?.focus();
              onSelect(null);
            }}
          >
            Clear selection
          </button>
        ) : null}
      </div>
      {agent === undefined ? (
        <SessionDetails model={model} />
      ) : (
        <AgentDetails model={model} agent={agent} />
      )}
    </section>
  );
}
