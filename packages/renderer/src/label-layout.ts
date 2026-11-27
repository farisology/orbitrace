/**
 * Label placement: where each label goes so that no two overlap. Pure: it reads the scene, the
 * layout, the frame state and the view, plus label widths the caller measured, and writes
 * positions into a preallocated `LabelBoard`. Placing labels allocates nothing.
 *
 * Rules (#14):
 * - Agent labels never overlap each other, a wave label or the main agent's label.
 * - Labels are placed greedily in priority order: the main agent, the selected agent, the
 *   hovered agent, the wave labels, then running subagents, then finished ones, each group in
 *   id order. A label that finds no free spot is dropped, so when room runs out the finished
 *   agents' labels go first. The selected and hovered agents' labels are always shown.
 * - Each label tries a few spots around its node: outward from the centre (the old fixed
 *   spot), inward, then to the right and to the left. At full detail it first looks for a spot
 *   that also covers no other node, then for one that only avoids other labels.
 * - At most `budget` labels of agents that are neither selected nor hovered are shown; the
 *   level of detail sets the budget (see lod.ts).
 */

import type { Layout } from "./layout.js";
import type { Scene } from "./scene.js";
import { PHASE_ACTIVE, PHASE_DONE, PHASE_QUEUED, type FrameState } from "./timeline.js";

/** Clear space kept between two label boxes, in CSS pixels. */
export const LABEL_GAP = 2;
/** Horizontal padding of the dark box drawn behind a label (see `drawTagRow`). */
export const LABEL_PAD_X = 3;
/** Distance from a node's outer radius to the baseline of a label placed outward or inward. */
export const AGENT_LABEL_OFFSET = 33;
/** The same for the main agent, whose node is larger. */
export const MAIN_LABEL_OFFSET = 35;
/** Distance from a node's outer radius to a label placed beside it. */
export const SIDE_LABEL_OFFSET = 26;
/** Baseline of a detail row below (or above) the agent's label, for labels up to 10 px. */
export const DETAIL_LINE = 14;
/** Font size of the detail row and the wave labels (`FONTS.small`). */
export const SMALL_FONT_SIZE = 9;
/** Labels stay this far inside the canvas edges, as `drawTagRow` keeps them. */
export const EDGE_MARGIN = 4;

/** Spots a label tries, in order. */
export const SPOT_OUTWARD = 0;
export const SPOT_INWARD = 1;
export const SPOT_RIGHT = 2;
export const SPOT_LEFT = 3;
export const SPOT_COUNT = 4;

/** What a placed box belongs to, in `LabelBoard.boxKind`. */
export const BOX_AGENT = 0;
export const BOX_DETAIL = 1;
export const BOX_WAVE = 2;

export interface LabelBoard {
  /** Agents and waves this board has room for. */
  readonly agentCapacity: number;
  readonly waveCapacity: number;

  // Inputs, written by the caller before `placeLabels`.
  /** Width of the label each agent would show (bold when selected), in CSS pixels. */
  readonly agentWidth: Float64Array;
  /** Font size of each agent's label. */
  readonly agentSize: Float64Array;
  /** Width of the selected or hovered agent's detail row, or 0 for none. */
  readonly detailWidth: Float64Array;
  /** Width of each wave label, or 0 for a wave with no label. */
  readonly waveWidth: Float64Array;
  /** 1 for a wave drawn as a ring summary (lod.ts): its agents want no label. */
  readonly waveCollapsed: Uint8Array;
  /** Scratch for lod.ts: agents of each wave that are not finished. */
  readonly waveOpen: Uint32Array;

  // Outputs.
  /** 1 when the agent's label is shown. */
  readonly agentShown: Uint8Array;
  /** The spot each shown label took (SPOT_*). */
  readonly agentSpot: Uint8Array;
  /** Left edge of the label text and its baseline. */
  readonly agentLeft: Float64Array;
  readonly agentBase: Float64Array;
  /** Left edge and baseline of the detail row, when `detailWidth` is above 0. */
  readonly detailLeft: Float64Array;
  readonly detailBase: Float64Array;
  /** 1 when the wave label is shown, with its left edge and baseline. */
  readonly waveShown: Uint8Array;
  readonly waveLeft: Float64Array;
  readonly waveBase: Float64Array;
  /** Agents that wanted a label and did not get one this frame. */
  dropped: number;

  /** Every placed box as [left, top, right, bottom], `boxCount` of them. */
  readonly boxes: Float64Array;
  readonly boxKind: Uint8Array;
  /** Agent index or wave index of each box. */
  readonly boxOwner: Int32Array;
  boxCount: number;
}

export function createLabelBoard(agents: number, waves: number): LabelBoard {
  const n = Math.max(1, agents);
  const m = Math.max(1, waves);
  const boxes = 2 * n + m;
  return {
    agentCapacity: n,
    waveCapacity: m,
    agentWidth: new Float64Array(n),
    agentSize: new Float64Array(n),
    detailWidth: new Float64Array(n),
    waveWidth: new Float64Array(m),
    waveCollapsed: new Uint8Array(m),
    waveOpen: new Uint32Array(m),
    agentShown: new Uint8Array(n),
    agentSpot: new Uint8Array(n),
    agentLeft: new Float64Array(n),
    agentBase: new Float64Array(n),
    detailLeft: new Float64Array(n),
    detailBase: new Float64Array(n),
    waveShown: new Uint8Array(m),
    waveLeft: new Float64Array(m),
    waveBase: new Float64Array(m),
    dropped: 0,
    boxes: new Float64Array(boxes * 4),
    boxKind: new Uint8Array(boxes),
    boxOwner: new Int32Array(boxes),
    boxCount: 0,
  };
}

/** True when `board` has room for a scene of this size. */
export function boardFits(board: LabelBoard, agents: number, waves: number): boolean {
  return board.agentCapacity >= agents && board.waveCapacity >= waves;
}

/** True when the boxes [l0, t0, r0, b0] and [l1, t1, r1, b1] overlap, gap included. */
export function boxesOverlap(
  l0: number,
  t0: number,
  r0: number,
  b0: number,
  l1: number,
  t1: number,
  r1: number,
  b1: number,
  gap = LABEL_GAP,
): boolean {
  return l0 < r1 + gap && l1 < r0 + gap && t0 < b1 + gap && t1 < b0 + gap;
}

/** Scratch for one candidate spot: callsign box, then detail box ([l, t, r, b] each). */
const cand = new Float64Array(8);
/** Scratch for the text positions of a candidate: left, base, detailLeft, detailBase. */
const text = new Float64Array(4);

function clampLeft(left: number, width: number, canvasWidth: number): number {
  return Math.max(EDGE_MARGIN, Math.min(canvasWidth - width - EDGE_MARGIN, left));
}

/**
 * Fill `cand` and `text` with the boxes and text positions of agent `i`'s label at `spot`.
 * Box geometry matches what `drawTagRow` paints: the text plus `LABEL_PAD_X` either side, from
 * `size - 1` above the baseline to 4 below it.
 */
function spotBoxes(
  scene: Scene,
  layout: Layout,
  board: LabelBoard,
  i: number,
  spot: number,
  withDetail: boolean,
): void {
  const a = scene.agents[i]!;
  const x = layout.x[i]!;
  const y = layout.y[i]!;
  const ro = layout.ro[i]!;
  const w = board.agentWidth[i]!;
  const size = board.agentSize[i]!;
  const dw = withDetail ? board.detailWidth[i]! : 0;
  const offset = a.isMain ? MAIN_LABEL_OFFSET : AGENT_LABEL_OFFSET;
  // Outward is down for the main agent and for nodes on the lower half, up otherwise.
  const up = !a.isMain && y < layout.cy;
  let base: number;
  let dy: number;
  let centre = x;
  if (spot === SPOT_OUTWARD || spot === SPOT_INWARD) {
    const above = spot === SPOT_OUTWARD ? up : !up;
    dy = above ? -1 : 1;
    base = y + dy * (ro + offset) + (above ? 0 : SMALL_FONT_SIZE);
  } else {
    dy = 1;
    base = y + size / 2 - 1;
    const block = Math.max(w, dw);
    centre =
      spot === SPOT_RIGHT
        ? x + ro + SIDE_LABEL_OFFSET + block / 2
        : x - ro - SIDE_LABEL_OFFSET - block / 2;
  }
  const left = clampLeft(centre - w / 2, w, layout.width);
  cand[0] = left - LABEL_PAD_X;
  cand[1] = base - size + 1;
  cand[2] = left + w + LABEL_PAD_X;
  cand[3] = base + 4;
  text[0] = left;
  text[1] = base;
  if (dw > 0) {
    // One line below or above the label; a line is never shorter than the label's own box.
    const dBase = base + dy * Math.max(DETAIL_LINE, size + 3);
    const dLeft = clampLeft(centre - dw / 2, dw, layout.width);
    cand[4] = dLeft - LABEL_PAD_X;
    cand[5] = dBase - SMALL_FONT_SIZE + 1;
    cand[6] = dLeft + dw + LABEL_PAD_X;
    cand[7] = dBase + 4;
    text[2] = dLeft;
    text[3] = dBase;
  } else {
    cand[4] = cand[5] = cand[6] = cand[7] = 0;
  }
}

/** True when the box in `cand` at `o` overlaps any placed box. */
function hitsBoxes(board: LabelBoard, o: number): boolean {
  const b = board.boxes;
  for (let k = 0; k < board.boxCount; k++) {
    const p = k * 4;
    if (
      boxesOverlap(
        cand[o]!,
        cand[o + 1]!,
        cand[o + 2]!,
        cand[o + 3]!,
        b[p]!,
        b[p + 1]!,
        b[p + 2]!,
        b[p + 3]!,
      )
    )
      return true;
  }
  return false;
}

/** True when the box in `cand` at `o` covers the node of a drawn agent other than `self`. */
function hitsNodes(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  self: number,
  o: number,
): boolean {
  for (let j = 0; j < scene.agents.length; j++) {
    if (j === self || (j !== 0 && frame.phase[j] === PHASE_QUEUED)) continue;
    const x = layout.x[j]!;
    const y = layout.y[j]!;
    const ro = layout.ro[j]!;
    if (
      boxesOverlap(
        cand[o]!,
        cand[o + 1]!,
        cand[o + 2]!,
        cand[o + 3]!,
        x - ro,
        y - ro,
        x + ro,
        y + ro,
        0,
      )
    )
      return true;
  }
  return false;
}

function candidateFree(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  board: LabelBoard,
  i: number,
  withDetail: boolean,
  avoidNodes: boolean,
): boolean {
  if (hitsBoxes(board, 0)) return false;
  if (withDetail && hitsBoxes(board, 4)) return false;
  if (avoidNodes) {
    if (hitsNodes(scene, layout, frame, i, 0)) return false;
    if (withDetail && hitsNodes(scene, layout, frame, i, 4)) return false;
  }
  return true;
}

function pushBox(board: LabelBoard, o: number, kind: number, owner: number): void {
  const k = board.boxCount++;
  const p = k * 4;
  board.boxes[p] = cand[o]!;
  board.boxes[p + 1] = cand[o + 1]!;
  board.boxes[p + 2] = cand[o + 2]!;
  board.boxes[p + 3] = cand[o + 3]!;
  board.boxKind[k] = kind;
  board.boxOwner[k] = owner;
}

/**
 * Try to place agent `i`'s label. A forced label (main, selected, hovered) is placed even when
 * every spot is taken, at the first spot that avoids labels if there is one, else outward.
 * Returns true when the label was placed.
 */
function placeAgent(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  board: LabelBoard,
  i: number,
  forced: boolean,
  avoidNodes: boolean,
): boolean {
  const withDetail = board.detailWidth[i]! > 0;
  let chosen = -1;
  for (let pass = avoidNodes ? 0 : 1; pass < 2 && chosen < 0; pass++) {
    for (let spot = 0; spot < SPOT_COUNT; spot++) {
      spotBoxes(scene, layout, board, i, spot, withDetail);
      if (candidateFree(scene, layout, frame, board, i, withDetail, pass === 0)) {
        chosen = spot;
        break;
      }
    }
  }
  if (chosen < 0) {
    if (!forced) return false;
    chosen = SPOT_OUTWARD;
  }
  spotBoxes(scene, layout, board, i, chosen, withDetail);
  board.agentShown[i] = 1;
  board.agentSpot[i] = chosen;
  board.agentLeft[i] = text[0]!;
  board.agentBase[i] = text[1]!;
  pushBox(board, 0, BOX_AGENT, i);
  if (withDetail) {
    board.detailLeft[i] = text[2]!;
    board.detailBase[i] = text[3]!;
    pushBox(board, 4, BOX_DETAIL, i);
  }
  return true;
}

/** True when agent `i` would show a label this frame, before any collision or budget. */
export function wantsLabel(
  scene: Scene,
  frame: FrameState,
  board: LabelBoard,
  i: number,
  selected: number,
  hovered: number,
): boolean {
  const a = scene.agents[i]!;
  if (a.isMain || i === selected || i === hovered) return true;
  const phase = frame.phase[i]!;
  if (phase === PHASE_QUEUED) return false;
  if (a.wave >= 0 && board.waveCollapsed[a.wave] === 1) return false;
  // Finished agents lose their label unless nothing is running any more.
  return phase !== PHASE_DONE || frame.activeSubagents === 0;
}

/**
 * Place every label for this frame into `board`. `budget` caps the labels of agents that are
 * neither selected nor hovered (the main agent's label is always shown and not counted).
 */
export function placeLabels(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  selected: number,
  hovered: number,
  budget: number,
  avoidNodes: boolean,
  board: LabelBoard,
): LabelBoard {
  const n = scene.agents.length;
  board.boxCount = 0;
  board.dropped = 0;
  for (let i = 0; i < n; i++) board.agentShown[i] = 0;
  for (let w = 0; w < layout.ringCount; w++) board.waveShown[w] = 0;
  if (n === 0 || layout.width <= 0 || layout.height <= 0) return board;

  // 1. Forced: the main agent, the selected agent, the hovered agent.
  placeAgent(scene, layout, frame, board, 0, true, avoidNodes);
  if (selected > 0 && selected < n)
    placeAgent(scene, layout, frame, board, selected, true, avoidNodes);
  if (hovered > 0 && hovered < n && hovered !== selected)
    placeAgent(scene, layout, frame, board, hovered, true, avoidNodes);

  // 2. Wave labels sit at fixed spots: left of the vertical axis, above each orbit.
  for (let w = 0; w < layout.ringCount; w++) {
    const width = board.waveWidth[w]!;
    if (!(width > 0)) continue;
    const left = layout.cx - 6 - width;
    const base = layout.cy - layout.ringRadius[w]! - 5;
    cand[0] = left - 1;
    cand[1] = base - SMALL_FONT_SIZE;
    cand[2] = left + width + 1;
    cand[3] = base + 3;
    if (hitsBoxes(board, 0)) continue;
    board.waveShown[w] = 1;
    board.waveLeft[w] = left;
    board.waveBase[w] = base;
    pushBox(board, 0, BOX_WAVE, w);
  }

  // 3. Running subagents, then finished ones, each in id order, up to the budget.
  let shown = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n; i++) {
      if (i === selected || i === hovered) continue;
      if ((frame.phase[i] === PHASE_ACTIVE) !== (pass === 0)) continue;
      if (!wantsLabel(scene, frame, board, i, selected, hovered)) continue;
      if (shown >= budget || !placeAgent(scene, layout, frame, board, i, false, avoidNodes)) {
        board.dropped++;
        continue;
      }
      shown++;
    }
  }
  return board;
}
