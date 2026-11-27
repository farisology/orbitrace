/**
 * Hosts the renderer on a canvas. The app owns the clock: this component forwards the clock's
 * time, play state and rate to the `OrreryHandle`, and the model and selection from props.
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReplayAgentId, ReplayModel } from "@orbitrace/core";
import { createOrrery, type OrreryHandle, type OrreryOptions } from "@orbitrace/renderer";
import { useClock } from "../use-clock";
import { plural } from "../format";
import { ScopeTable } from "./ScopeTable";

/** Makes a renderer on a canvas. The app uses `createOrrery`; tests pass a fake. */
export type OrreryFactory = (canvas: HTMLCanvasElement, options: OrreryOptions) => OrreryHandle;

export const OrreryFactoryContext = createContext<OrreryFactory>(createOrrery);

export const ORRERY_FAILED_MESSAGE =
  "The orrery could not start in this browser (no 2D canvas). The timeline, inspector and events still work.";

export interface OrreryViewProps {
  readonly model: ReplayModel;
  /** Changes when a different replay is loaded (`setModel`); stays the same for live snapshots (`updateModel`). */
  readonly generation: number;
  readonly selected: ReplayAgentId | null;
  readonly onSelect: (agentId: ReplayAgentId | null) => void;
  readonly reducedMotion: boolean;
}

/**
 * Short text alternative for the canvas. The full one is the table of agents right after it
 * (`ScopeTable`). The table is not tied to the canvas with `aria-describedby`, so a screen reader
 * does not read the whole table each time it reaches the canvas.
 */
export function orreryLabel(model: ReplayModel): string {
  const subagents = model.agents.length - 1;
  return `Orrery: the main agent in the centre, ${plural(subagents, "subagent")} in orbit, ${plural(
    model.totals.toolCalls,
    "tool call",
  )}. The table of agents after it lists what it shows; select an agent with the timeline lanes.`;
}

export function OrreryView({
  model,
  generation,
  selected,
  onSelect,
  reducedMotion,
}: OrreryViewProps) {
  const factory = useContext(OrreryFactoryContext);
  const clock = useClock();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<OrreryHandle | null>(null);
  const appliedRef = useRef<{ model: ReplayModel; generation: number } | null>(null);
  const latest = useRef({ model, generation, selected, onSelect });
  // Runs before the effects below, so they always read the props of this render.
  useLayoutEffect(() => {
    latest.current = { model, generation, selected, onSelect };
  });
  const [failed, setFailed] = useState(false);
  const tableId = useId();
  const [hovered, setHovered] = useState<ReplayAgentId | null>(null);

  // Create the renderer; again when the motion preference or the factory changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    let handle: OrreryHandle;
    try {
      handle = factory(canvas, { reducedMotion });
    } catch {
      setFailed(true);
      return;
    }
    setFailed(false);
    handleRef.current = handle;
    const rect = container.getBoundingClientRect();
    handle.resize(rect.width, rect.height);
    const start = clock.getState();
    const current = latest.current;
    handle.setSpeed(start.rate);
    handle.setModel(current.model);
    appliedRef.current = { model: current.model, generation: current.generation };
    handle.setTime(start.time);
    handle.select(current.selected);
    if (start.playing) handle.play();

    const offSelect = handle.on("select", ({ agentId }) => latest.current.onSelect(agentId));
    const offHover = handle.on("hover", ({ agentId }) => setHovered(agentId));
    let previous = start;
    const offClock = clock.subscribe(() => {
      const next = clock.getState();
      if (next.rate !== previous.rate) handle.setSpeed(next.rate);
      if (next.time !== previous.time) handle.setTime(next.time);
      if (next.playing !== previous.playing) {
        if (next.playing) handle.play();
        else handle.pause();
      }
      previous = next;
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box !== undefined) handle.resize(box.width, box.height);
          });
    observer?.observe(container);

    return () => {
      offClock();
      offSelect();
      offHover();
      observer?.disconnect();
      handle.destroy();
      handleRef.current = null;
      appliedRef.current = null;
    };
  }, [clock, factory, reducedMotion]);

  // A new replay replaces the model; a newer snapshot of the same one updates it.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) return;
    const applied = appliedRef.current;
    if (applied !== null && applied.model === model) return;
    if (applied !== null && applied.generation === generation) {
      handle.updateModel(model);
    } else {
      handle.setModel(model);
      handle.select(latest.current.selected);
    }
    handle.setTime(clock.getState().time);
    appliedRef.current = { model, generation };
  }, [clock, model, generation]);

  useEffect(() => {
    handleRef.current?.select(selected);
  }, [selected]);

  const hoveredName =
    hovered === null ? "" : (model.agents.find((agent) => agent.id === hovered)?.callsign ?? "");

  return (
    <div className="orrery" ref={containerRef}>
      <h2 className="visually-hidden">Orrery</h2>
      <canvas
        ref={canvasRef}
        className="orrery-canvas"
        role="img"
        aria-label={orreryLabel(model)}
        title={hoveredName}
      />
      <ScopeTable model={model} selected={selected} id={tableId} />
      {failed ? (
        <p className="orrery-failed" role="status">
          {ORRERY_FAILED_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}
