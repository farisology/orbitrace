/**
 * Label placement: where each label goes so that no two overlap. Pure: it reads the scene, the
 * layout, the frame state and the view, plus label widths the caller measured, and writes
 * positions into a preallocated `LabelBoard`. Placing labels allocates nothing.
 *
 * Rules (#14, #128):
 * - Agent labels never overlap each other, a wave label or the main agent's label.
 * - Labels are placed greedily in priority order: the main agent, the selected agent, the
 *   hovered agent, the wave labels, then running subagents, then finished ones, each group in
 *   id order. An agent label that finds no free spot is dropped, so when room runs out the
 *   finished agents' labels go first. The selected and hovered agents' labels are always shown.
 * - Each wave label sits on its own ring, centred on it, at one of `WAVE_BINS` angles. Each
 *   angle is scored against what is drawn there this frame: agent nodes with their token arc,
 *   orbit dash and reticle, moons, and (at full detail) tool beams and spoke tags are hits;
 *   agent slots, the reach of running agents' beams and the tethers are soft costs. A label
 *   keeps its angle while that spot gets no more hits than when it took it, so it does not jump
 *   from frame to frame; otherwise it moves to the free angle with the fewest hits (then the
 *   lowest soft cost), fading across in `WAVE_FADE_SECONDS` while the clock runs and at once
 *   when paused. A label left on a hit spot (a crowded ring) looks again every
 *   `WAVE_RETRY_FRAMES` frames. Another label or the canvas edge rules an angle out; a wave
 *   label is dropped only when no angle on its ring is free of those, that is when the canvas
 *   is too small for it. Most frames only check the spots held, which costs one box test per
 *   wave and obstacle.
 * - Each label tries a few spots around its node: outward from the centre (the old fixed
 *   spot), inward, then to the right and to the left. At full detail it first looks for a spot
 *   that also covers no other node, then for one that only avoids other labels.
 * - At most `budget` labels of agents that are neither selected nor hovered are shown; the
 *   level of detail sets the budget (see lod.ts).
 */

import type { Layout } from "./layout.js";
import { LOD_FULL, drawsMoons, drawsSpokeTags } from "./lod.js";
import type { Scene } from "./scene.js";
import {
  EFFECT_SECONDS,
  PHASE_ACTIVE,
  PHASE_DONE,
  PHASE_QUEUED,
  type FrameState,
} from "./timeline.js";

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

/** Angles a wave label can take on its ring; bin 0 is straight up, then clockwise. */
export const WAVE_BINS = 72;
/** Horizontal padding of a wave label's backing box. */
export const WAVE_PAD_X = 4;
/** Half the height of a wave label's backing box, which is centred on the ring. */
export const WAVE_HALF_HEIGHT = 6.5;
/** The text baseline sits this far below the ring, so the capitals are centred on it. */
export const WAVE_BASELINE_DROP = 3;
/**
 * A wave label on a spot that is hit but no worse than when it took it (a crowded ring) looks
 * for a clearer one every this many frames, wave labels in turn, rather than every frame.
 */
export const WAVE_RETRY_FRAMES = 90;
/** How long a wave label takes to fade across to a new angle while the clock runs. */
export const WAVE_FADE_SECONDS = 0.3;
/** The angle a wave label prefers when several are clear: up and a little left of the axis. */
export const WAVE_PREFERRED_ANGLE = -Math.PI / 2 - 0.3;
/**
 * Hit weights (#128). When no angle is free (a small canvas late in a busy session) the label
 * takes the one with the least weight: it covers moons, a reticle or a spoke tag before a beam,
 * and many of those before a single node.
 */
const HIT_NODE = 100;
const HIT_BEAM = 10;
const HIT_RETICLE = 3;
const HIT_TAG = 2;
const HIT_MOONS = 1;
/** Soft costs (#128): reach of a running agent's beams, a tether sample, preference. */
const SOFT_REACH = 40;
/**
 * Soft cost of an agent's slot whatever its phase, so labels settle between slots and a
 * waiting agent that appears does not land on them.
 */
const SOFT_SLOT = 60;
const SOFT_TETHER = 20;
const SOFT_PREFERENCE = 2;
/** Clear space around a beam's bounding box and around the beam tip's dot. */
const BEAM_PAD = 3;
const TIP_RADIUS = 6;

const BIN_STEP = (Math.PI * 2) / WAVE_BINS;
const binCos = new Float64Array(WAVE_BINS);
const binSin = new Float64Array(WAVE_BINS);
const binPreference = new Float64Array(WAVE_BINS);
for (let b = 0; b < WAVE_BINS; b++) {
  const angle = -Math.PI / 2 + b * BIN_STEP;
  binCos[b] = Math.cos(angle);
  binSin[b] = Math.sin(angle);
  let d = Math.abs(angle - WAVE_PREFERRED_ANGLE) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  binPreference[b] = d * SOFT_PREFERENCE;
}

/** Angle of wave bin `bin`, in radians (canvas convention: y down, so clockwise). */
export function waveBinAngle(bin: number): number {
  return -Math.PI / 2 + bin * BIN_STEP;
}

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
  /** Opacity of the wave label: 1, or less while it fades in at a new angle. */
  readonly waveAlpha: Float64Array;
  /** 1 while the wave label fades out at its old angle, with that spot and its opacity. */
  readonly waveGhostShown: Uint8Array;
  readonly waveGhostLeft: Float64Array;
  readonly waveGhostBase: Float64Array;
  readonly waveGhostAlpha: Float64Array;

  // State kept from frame to frame, so wave labels stay put.
  /** Angle bin each wave label holds (WAVE_BINS), or -1 for none yet. */
  readonly waveBin: Int32Array;
  /** Bin the wave label is fading out of, or -1. */
  readonly wavePrevBin: Int32Array;
  /** Progress of the fade to `waveBin`, from 0 to 1 (1: settled). */
  readonly waveFade: Float64Array;
  /**
   * Hits of the spot when the label took it, lowered as the spot clears. The label looks for a
   * new spot when its own gets more hits than this (it became occupied).
   */
  readonly waveSettled: Float64Array;
  /** Frames placed so far, which staggers the retries (`WAVE_RETRY_FRAMES`). */
  waveFrames: number;
  /** 1 for each wave label looking for a new spot this frame. */
  readonly waveSearching: Uint8Array;
  /** The rings being scored, `waveListCount` of them, with each label's half box width. */
  readonly waveList: Int32Array;
  waveListCount: number;
  readonly waveHalfWidth: Float64Array;
  /** Centre of the spot each label holds, while checking. */
  readonly waveSpotX: Float64Array;
  readonly waveSpotY: Float64Array;
  /** Ambient clock of the previous frame, NaN before the first; fades run only while it moves. */
  lastAmbient: number;
  /** Frames so far in which some wave label looked for a new spot (scored every angle). */
  waveSearches: number;

  // Scratch for wave placement, `WAVE_BINS` per wave. A frame in which every label can stay
  // only scores the angle each one holds; the full rows are from the last frame that searched.
  /** Hits per angle (weighted): nodes, beams, reticles, spoke tags, moons. */
  readonly waveHit: Float64Array;
  /** Soft cost per angle: beam reach, tethers, preference. */
  readonly waveSoft: Float64Array;
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
    waveAlpha: new Float64Array(m),
    waveGhostShown: new Uint8Array(m),
    waveGhostLeft: new Float64Array(m),
    waveGhostBase: new Float64Array(m),
    waveGhostAlpha: new Float64Array(m),
    waveBin: new Int32Array(m).fill(-1),
    wavePrevBin: new Int32Array(m).fill(-1),
    waveFade: new Float64Array(m).fill(1),
    waveSettled: new Float64Array(m),
    waveFrames: 0,
    waveSearching: new Uint8Array(m),
    waveList: new Int32Array(m),
    waveListCount: 0,
    waveHalfWidth: new Float64Array(m),
    waveSpotX: new Float64Array(m),
    waveSpotY: new Float64Array(m),
    lastAmbient: Number.NaN,
    waveSearches: 0,
    waveHit: new Float64Array(m * WAVE_BINS),
    waveSoft: new Float64Array(m * WAVE_BINS),
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
 * How the wave angles are being scored this frame: true scores every angle near each obstacle
 * on the rings whose label looks for a new spot (`waveSearching`); false only checks the spot
 * each wave holds, which is all a frame needs while every label can stay. The rings scored are
 * `board.waveList`.
 */
let scoreSearch = false;

/**
 * Add `hit` to the hits and `soft` to the soft cost of every wave angle whose label box would
 * overlap the box [l, t, r, b], on the rings in `board.waveList`. Searching, each ring tests
 * only the angles near the box; checking (`scoreSearch` false), each tests just the spot its
 * label holds, and soft costs are skipped.
 */
function markObstacle(
  layout: Layout,
  board: LabelBoard,
  l: number,
  t: number,
  r: number,
  b: number,
  hit: number,
  soft: number,
): void {
  if (!scoreSearch) soft = 0;
  if (hit === 0 && soft === 0) return;
  const qx = (l + r) / 2;
  const qy = (t + b) / 2;
  const ex = (r - l) / 2;
  const ey = (b - t) / 2;
  const dx = qx - layout.cx;
  const dy = qy - layout.cy;
  const hh = WAVE_HALF_HEIGHT + ey;
  const hits = board.waveHit;
  const softs = board.waveSoft;
  const list = board.waveList;
  if (!scoreSearch) {
    // Check: one box per wave, at the spot it holds.
    for (let k = 0; k < board.waveListCount; k++) {
      const w = list[k]!;
      if (
        Math.abs(board.waveSpotX[w]! - qx) < board.waveHalfWidth[w]! + ex &&
        Math.abs(board.waveSpotY[w]! - qy) < hh
      ) {
        hits[w * WAVE_BINS + board.waveBin[w]!]! += hit;
      }
    }
    return;
  }
  const d = Math.sqrt(dx * dx + dy * dy);
  let centre = Number.NaN;
  for (let k = 0; k < board.waveListCount; k++) {
    const w = list[k]!;
    const R = layout.ringRadius[w]!;
    const hw = board.waveHalfWidth[w]! + ex;
    const reach = Math.sqrt(hw * hw + hh * hh);
    if (Math.abs(d - R) >= reach) continue;
    const row = w * WAVE_BINS;
    let lo = 0;
    let hi = WAVE_BINS - 1;
    if (d > reach && R > reach) {
      // A ring point P within `reach` of the box centre q is within reach + |d - R| of q's
      // projection on the ring, a chord of 2 R sin(angle / 2), so the angle is at most
      // 2 asin(x) <= 2 x / sqrt(1 - x^2) for x = chord / 2R. Plain arithmetic (no atan2 or
      // asin call), widened by a bin for the arctangent's small error.
      if (Number.isNaN(centre)) centre = (angleOf(dy, dx) + Math.PI / 2) / BIN_STEP;
      const x = (reach + Math.abs(d - R)) / (2 * R);
      const spread = x >= 0.9 ? WAVE_BINS : (2 * x) / Math.sqrt(1 - x * x) / BIN_STEP + 1;
      lo = Math.ceil(centre - spread);
      hi = Math.floor(centre + spread);
      if (hi - lo >= WAVE_BINS) {
        lo = 0;
        hi = WAVE_BINS - 1;
      }
    }
    for (let j = lo; j <= hi; j++) {
      // lo and hi stay within one turn of [0, WAVE_BINS), so one wrap is enough.
      const bin = j < 0 ? j + WAVE_BINS : j >= WAVE_BINS ? j - WAVE_BINS : j;
      const px = layout.cx + R * binCos[bin]!;
      const py = layout.cy + R * binSin[bin]!;
      if (Math.abs(px - qx) < hw && Math.abs(py - qy) < hh) {
        hits[row + bin]! += hit;
        softs[row + bin]! += soft;
      }
    }
  }
}

/**
 * `Math.atan2(y, x)` to within 2e-5 radians, in plain arithmetic: optimising compilers keep it
 * free of boxed numbers, where a call into the Math builtin may not be.
 */
export function angleOf(y: number, x: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const big = ax > ay ? ax : ay;
  if (big === 0) return 0;
  const z = (ax > ay ? ay : ax) / big;
  const z2 = z * z;
  let a = z * (0.999866 + z2 * (-0.3302995 + z2 * (0.180141 + z2 * (-0.085133 + z2 * 0.0208351))));
  if (ay > ax) a = Math.PI / 2 - a;
  if (x < 0) a = Math.PI - a;
  return y < 0 ? -a : a;
}

function markDisc(
  layout: Layout,
  board: LabelBoard,
  x: number,
  y: number,
  radius: number,
  hit: number,
  soft: number,
): void {
  markObstacle(layout, board, x - radius, y - radius, x + radius, y + radius, hit, soft);
}

/** Point `p` of the tether curve from (x0, y0) to (x1, y1), as draw.ts bends it. */
const BEND = 0.16;
const tether = new Float64Array(2);
function tetherPoint(p: number, x0: number, y0: number, x1: number, y1: number): void {
  const px = (x0 + x1) / 2 - (y1 - y0) * BEND;
  const py = (y0 + y1) / 2 + (x1 - x0) * BEND;
  const u = 1 - p;
  tether[0] = u * u * x0 + 2 * u * p * px + p * p * x1;
  tether[1] = u * u * y0 + 2 * u * p * py + p * p * y1;
}

/**
 * Score every wave angle against what this frame draws (see the rules at the top). The
 * geometry follows draw.ts: token arc at `ro + 3`, orbit dash at `ro + 6.5` while running,
 * reticle at `ro + 29`, moons up to `ro + 22.6`, spokes from `ro + 7` out by their length.
 */
function scoreWaveAngles(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  selected: number,
  hovered: number,
  board: LabelBoard,
  search: boolean,
): void {
  scoreSearch = search;
  board.waveListCount = 0;
  for (let w = 0; w < layout.ringCount; w++) {
    const width = board.waveWidth[w]!;
    if (!(width > 0)) continue;
    const bin = board.waveBin[w]!;
    if (search ? board.waveSearching[w] !== 1 : bin < 0) continue;
    board.waveList[board.waveListCount++] = w;
    board.waveHalfWidth[w] = width / 2 + WAVE_PAD_X;
    if (search) {
      for (let b = 0; b < WAVE_BINS; b++) {
        board.waveHit[w * WAVE_BINS + b] = 0;
        board.waveSoft[w * WAVE_BINS + b] = binPreference[b]!;
      }
    } else {
      const R = layout.ringRadius[w]!;
      board.waveSpotX[w] = layout.cx + R * binCos[bin]!;
      board.waveSpotY[w] = layout.cy + R * binSin[bin]!;
      board.waveHit[w * WAVE_BINS + bin] = 0;
    }
  }
  if (board.waveListCount === 0) return;
  const lod = scene.lod;
  const t = frame.t;
  const lead = frame.reducedMotion ? 0 : EFFECT_SECONDS.comet * frame.speed;
  const mx = layout.x[0]!;
  const my = layout.y[0]!;
  const n = scene.agents.length;
  for (let i = 0; i < n; i++) {
    const a = scene.agents[i]!;
    const phase = frame.phase[i]!;
    const focused = i === selected || i === hovered;
    const x = layout.x[i]!;
    const y = layout.y[i]!;
    const ro = layout.ro[i]!;
    if (!focused && a.wave >= 0 && board.waveCollapsed[a.wave] === 1) {
      markDisc(layout, board, x, y, 3, HIT_NODE, 0);
      continue;
    }
    if (search && !a.isMain && lod === LOD_FULL && t >= a.start - lead) {
      // Tethers, drawn from just before an agent is dispatched (a soft cost): where the curve
      // crosses each ring being scored. It runs nearly straight out from the centre, so the
      // point at the ring's share of the agent's distance is close to the crossing.
      const dist = Math.sqrt((x - mx) * (x - mx) + (y - my) * (y - my));
      for (let k = 0; k < board.waveListCount; k++) {
        const R = layout.ringRadius[board.waveList[k]!]!;
        if (R >= dist - ro) continue;
        tetherPoint(R / dist, mx, my, x, y);
        markDisc(layout, board, tether[0]!, tether[1]!, 2.5, 0, SOFT_TETHER);
      }
    }
    // A waiting agent's slot is a soft cost only: no node is drawn there yet.
    const slot = a.isMain ? 0 : SOFT_SLOT;
    if (!a.isMain && phase === PHASE_QUEUED) {
      markDisc(layout, board, x, y, ro + 8, 0, slot);
      continue;
    }
    const active = phase === PHASE_ACTIVE;
    // Body, token arc and, while running, the orbit dash; the reticle round a focused agent.
    markDisc(layout, board, x, y, ro + (active ? 8 : 4.5), HIT_NODE, slot);
    if (focused) markDisc(layout, board, x, y, ro + 30, HIT_RETICLE, 0);
    if (drawsMoons(lod, phase, focused) && frame.started[i]! > 0) {
      const rings = Math.min(3, frame.started[i]! - 1);
      markDisc(layout, board, x, y, ro + 10 + rings * 4.2 + 2.6, HIT_MOONS, 0);
    }
    if (search && active && a.maxFlareLength > 0) {
      markDisc(layout, board, x, y, ro + 7 + a.maxFlareLength + TIP_RADIUS, 0, SOFT_REACH);
    }

    // Spokes: calls in flight, each a hit along its whole length, with its spoke tag. Above
    // full detail (over 100 agents) the rings are too close and the spokes too many to dodge
    // without labels hopping every frame; labels are drawn on top of them with a backing.
    if (lod !== LOD_FULL) continue;
    let labelled = drawsSpokeTags(lod) ? 0 : 2;
    const from = frame.flightOffset[i]!;
    const to = frame.flightOffset[i + 1]!;
    for (let k = from; k < to; k++) {
      if (!(frame.flightAlpha[k]! > 0.05)) continue;
      const j = frame.flightTool[k]!;
      const angle = a.isMain ? a.flareAngle[j]! : layout.angle[i]! + a.flareAngle[j]!;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      const r0 = ro + 7;
      const reach = r0 + a.flareLength[j]! * frame.flightGrow[k]!;
      const x1 = x + c * r0;
      const y1 = y + sn * r0;
      const x2 = x + c * reach;
      const y2 = y + sn * reach;
      markObstacle(
        layout,
        board,
        Math.min(x1, x2) - BEAM_PAD,
        Math.min(y1, y2) - BEAM_PAD,
        Math.max(x1, x2) + BEAM_PAD,
        Math.max(y1, y2) + BEAM_PAD,
        HIT_BEAM,
        0,
      );
      markDisc(layout, board, x2, y2, TIP_RADIUS, HIT_BEAM, 0);
      if (layout.wide && labelled < 2 && frame.flightRunning[k] === 1) {
        const startT = a.toolStart[j]!;
        if (a.toolOpen[j] === 1 || a.toolEnd[j]! - startT > 3) {
          // The tag draw.ts puts beside the tip: the tool name and its seconds, centred.
          const name = a.toolLabel[j]!;
          const nameWidth = name.width >= 0 ? name.width : name.text.length * 5.5;
          const half = (nameWidth + 30) / 2 + LABEL_PAD_X;
          const tx = x2 + c * 22;
          const ty = y2 + sn * 10 + 3 - SMALL_FONT_SIZE / 2;
          markObstacle(layout, board, tx - half, ty - 7, tx + half, ty + 7, HIT_TAG, 0);
          labelled++;
        }
      }
    }
  }
}

/**
 * True when wave `w`'s label box at bin `bin` would leave the canvas or overlap one of the
 * first `board.boxCount` placed boxes.
 */
export function waveBinBlocked(layout: Layout, board: LabelBoard, w: number, bin: number): boolean {
  const R = layout.ringRadius[w]!;
  const hw = board.waveWidth[w]! / 2 + WAVE_PAD_X;
  const px = layout.cx + R * binCos[bin]!;
  const py = layout.cy + R * binSin[bin]!;
  const l = px - hw;
  const r = px + hw;
  const t = py - WAVE_HALF_HEIGHT;
  const b = py + WAVE_HALF_HEIGHT;
  if (l < EDGE_MARGIN || r > layout.width - EDGE_MARGIN) return true;
  if (t < EDGE_MARGIN || b > layout.height - EDGE_MARGIN) return true;
  cand[0] = l;
  cand[1] = t;
  cand[2] = r;
  cand[3] = b;
  return hitsBoxes(board, 0);
}

/** Write the text position of wave `w`'s label at `bin` into `text[0]` (left), `text[1]` (base). */
function waveText(layout: Layout, board: LabelBoard, w: number, bin: number): void {
  const R = layout.ringRadius[w]!;
  text[0] = layout.cx + R * binCos[bin]! - board.waveWidth[w]! / 2;
  text[1] = layout.cy + R * binSin[bin]! + WAVE_BASELINE_DROP;
}

/** Forget wave `w`'s angle and fade. */
function resetWave(board: LabelBoard, w: number): void {
  board.waveBin[w] = -1;
  board.wavePrevBin[w] = -1;
  board.waveFade[w] = 1;
  board.waveSettled[w] = 0;
}

/**
 * True when wave `w`'s label should look for a new spot this frame: it has none, its spot is
 * blocked by a label or the edge, or its spot has more hits than when it took it; or, every
 * `WAVE_RETRY_FRAMES` frames, its spot has any hit at all.
 */
function waveWantsSpot(board: LabelBoard, w: number, current: number, blocked: boolean): boolean {
  if (current < 0 || blocked) return true;
  const hit = board.waveHit[w * WAVE_BINS + current]!;
  if (hit > board.waveSettled[w]!) return true;
  return hit > 0 && (board.waveFrames + w) % WAVE_RETRY_FRAMES === 0;
}

/**
 * Place the wave labels (see the rules at the top). `dt` is the real time since the previous
 * frame while the clock runs, else 0, in which case a move is made at once with no fade.
 */
function placeWaves(
  scene: Scene,
  layout: Layout,
  frame: FrameState,
  selected: number,
  hovered: number,
  board: LabelBoard,
  dt: number,
): void {
  let any = false;
  for (let w = 0; w < layout.ringCount; w++) {
    if (board.waveWidth[w]! > 0) any = true;
    else resetWave(board, w);
  }
  if (!any) return;

  // Most frames every label can stay: check only the angles they hold. Each held spot counts
  // as taken while the next wave is checked.
  board.waveFrames++;
  const fixed = board.boxCount;
  scoreWaveAngles(scene, layout, frame, selected, hovered, board, false);
  let search = false;
  for (let w = 0; w < layout.ringCount; w++) {
    board.waveSearching[w] = 0;
    if (!(board.waveWidth[w]! > 0)) continue;
    const bin = board.waveBin[w]!;
    if (waveWantsSpot(board, w, bin, bin >= 0 && waveBinBlocked(layout, board, w, bin))) {
      board.waveSearching[w] = 1;
      search = true;
    }
    if (bin >= 0) pushWaveBox(layout, board, w, bin);
  }
  board.boxCount = fixed;
  if (search) {
    // Score every angle, on the rings that look for a spot only.
    board.waveSearches++;
    scoreWaveAngles(scene, layout, frame, selected, hovered, board, true);
  }

  // Labels that stay go down first, then the others pick the clearest free angle.
  for (let w = 0; w < layout.ringCount; w++) {
    if (!(board.waveWidth[w]! > 0) || board.waveSearching[w] === 1) continue;
    const bin = board.waveBin[w]!;
    board.waveSettled[w] = Math.min(board.waveSettled[w]!, board.waveHit[w * WAVE_BINS + bin]!);
    finishWave(layout, board, w, bin, dt);
  }
  if (!search) return;
  for (let w = 0; w < layout.ringCount; w++) {
    if (!(board.waveWidth[w]! > 0) || board.waveSearching[w] !== 1) continue;
    const row = w * WAVE_BINS;
    const current = board.waveBin[w]!;
    const currentOk = current >= 0 && !waveBinBlocked(layout, board, w, current);
    // The fewest hits, then the lowest soft cost, among angles free of labels and edges.
    let best = -1;
    for (let b = 0; b < WAVE_BINS; b++) {
      if (waveBinBlocked(layout, board, w, b)) continue;
      if (
        best < 0 ||
        board.waveHit[row + b]! < board.waveHit[row + best]! ||
        (board.waveHit[row + b] === board.waveHit[row + best] &&
          board.waveSoft[row + b]! < board.waveSoft[row + best]!)
      ) {
        best = b;
      }
    }
    if (best < 0) {
      resetWave(board, w);
      continue;
    }
    // Stay on an occupied spot when nowhere is less occupied.
    const bin =
      !currentOk || board.waveHit[row + best]! < board.waveHit[row + current]! ? best : current;
    board.waveSettled[w] = board.waveHit[row + bin]!;
    finishWave(layout, board, w, bin, dt);
  }
}

/**
 * Put wave `w`'s label at `bin`: start a fade when it moved while the clock runs (a move while
 * paused or with reduced motion is made at once), advance a fade under way, write its outputs
 * and push its box.
 */
function finishWave(layout: Layout, board: LabelBoard, w: number, bin: number, dt: number): void {
  const current = board.waveBin[w]!;
  if (bin !== current) {
    if (current >= 0 && dt > 0) {
      board.wavePrevBin[w] = current;
      board.waveFade[w] = 0;
    } else {
      board.wavePrevBin[w] = -1;
      board.waveFade[w] = 1;
    }
    board.waveBin[w] = bin;
  } else if (board.waveFade[w]! < 1) {
    board.waveFade[w] = dt > 0 ? Math.min(1, board.waveFade[w]! + dt / WAVE_FADE_SECONDS) : 1;
  }
  if (board.waveFade[w]! >= 1) board.wavePrevBin[w] = -1;

  waveText(layout, board, w, bin);
  board.waveShown[w] = 1;
  board.waveLeft[w] = text[0]!;
  board.waveBase[w] = text[1]!;
  board.waveAlpha[w] = board.waveFade[w]!;
  const prev = board.wavePrevBin[w]!;
  if (prev >= 0) {
    waveText(layout, board, w, prev);
    board.waveGhostShown[w] = 1;
    board.waveGhostLeft[w] = text[0]!;
    board.waveGhostBase[w] = text[1]!;
    board.waveGhostAlpha[w] = 1 - board.waveFade[w]!;
  }
  pushWaveBox(layout, board, w, bin);
}

/** Push wave `w`'s label box at `bin` onto the board. */
function pushWaveBox(layout: Layout, board: LabelBoard, w: number, bin: number): void {
  const R = layout.ringRadius[w]!;
  const hw = board.waveWidth[w]! / 2 + WAVE_PAD_X;
  const px = layout.cx + R * binCos[bin]!;
  const py = layout.cy + R * binSin[bin]!;
  cand[0] = px - hw;
  cand[1] = py - WAVE_HALF_HEIGHT;
  cand[2] = px + hw;
  cand[3] = py + WAVE_HALF_HEIGHT;
  pushBox(board, 0, BOX_WAVE, w);
}

/**
 * Place every label for this frame into `board`. `budget` caps the labels of agents that are
 * neither selected nor hovered (the main agent's label is always shown and not counted).
 * `ambient` is the engine's ambient clock (real seconds, frozen while paused or with reduced
 * motion); a wave label fades to a new angle only while it moves, and moves at once otherwise.
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
  ambient = Number.NaN,
): LabelBoard {
  const n = scene.agents.length;
  const previous = board.lastAmbient;
  board.lastAmbient = ambient;
  const step = ambient - previous;
  const dt = !frame.reducedMotion && step > 0 && step < 0.5 ? step : 0;
  board.boxCount = 0;
  board.dropped = 0;
  for (let i = 0; i < n; i++) board.agentShown[i] = 0;
  for (let w = 0; w < layout.ringCount; w++) {
    board.waveShown[w] = 0;
    board.waveGhostShown[w] = 0;
  }
  if (n === 0 || layout.width <= 0 || layout.height <= 0) return board;

  // 1. Forced: the main agent, the selected agent, the hovered agent.
  placeAgent(scene, layout, frame, board, 0, true, avoidNodes);
  if (selected > 0 && selected < n)
    placeAgent(scene, layout, frame, board, selected, true, avoidNodes);
  if (hovered > 0 && hovered < n && hovered !== selected)
    placeAgent(scene, layout, frame, board, hovered, true, avoidNodes);

  // 2. Wave labels, each on its own ring at the clearest angle, kept while it stays clear.
  placeWaves(scene, layout, frame, selected, hovered, board, dt);

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
