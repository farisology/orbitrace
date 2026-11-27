/**
 * Scene: everything the engine derives from a model once, when the model is loaded, so the
 * per-frame code reads flat typed arrays and never allocates. Pure: no canvas, no DOM.
 */

import type { ReplayAgent, ReplayAgentId, ReplayModel } from "@orbitrace/core";
import { createFlashSchedule, type FlashSchedule } from "./flash.js";
import { formatDuration, formatTokens } from "./format.js";
import { FONTS, Label } from "./labels.js";
import { lodFor } from "./lod.js";
import { effortFill, shapeForFamily, type NodeShape } from "./shapes.js";
import { bucketFor } from "./theme.js";

/** Golden angle in radians: spreads moons evenly however many there are. */
const GOLDEN_ANGLE = 2.39996;

export interface AgentScene {
  readonly id: ReplayAgentId;
  readonly index: number;
  readonly isMain: boolean;
  readonly agent: ReplayAgent;
  readonly shape: NodeShape;
  /** Effort fill fraction, 0 for hollow. */
  readonly fill: number;
  readonly maxEffort: boolean;
  readonly start: number;
  /** `Infinity` while the agent is still running. */
  readonly end: number;
  /** -1 for the main agent. */
  readonly wave: number;
  /** Position of this agent among the agents of its wave, in id order. */
  readonly waveSlot: number;
  readonly callsign: Label;
  readonly callsignBold: Label;
  /** For example `Opus · high`. */
  readonly identity: Label;
  /** Handback comet label, for example `+12.3k`. */
  readonly handback: Label;
  /** A stable number per agent id, for ambient phase offsets. */
  readonly seed: number;

  readonly toolCount: number;
  readonly toolStart: Float64Array;
  /** End of each call; an open call ends with its agent (`Infinity` while the agent runs). */
  readonly toolEnd: Float64Array;
  /** 1 when the call has no result yet. */
  readonly toolOpen: Uint8Array;
  /** Colour bucket once the call has a result: the failure bucket for failed calls. */
  readonly toolBucket: Uint8Array;
  /** Colour bucket by kind only, used while the call is still running. */
  readonly toolKindBucket: Uint8Array;
  readonly toolFailed: Uint8Array;
  /** 1 for calls not drawn as moons or spokes: the main agent's `agent` calls (tethers show them). */
  readonly toolSkip: Uint8Array;
  readonly moonCos: Float32Array;
  readonly moonSin: Float32Array;
  /** Distance of the moon outside the node's outer radius, in CSS pixels. */
  readonly moonRing: Float32Array;
  /** Main agent: absolute spoke angle. Subagent: offset from the outward direction. */
  readonly flareAngle: Float32Array;
  readonly flareLength: Float32Array;
  /** Longest `flareLength` of any call, 0 with none: how far a spoke can reach. */
  readonly maxFlareLength: number;
  /** Label per call (the tool name), shared between calls with the same name. */
  readonly toolLabel: readonly Label[];

  readonly replyCount: number;
  readonly replyT: Float64Array;
  /** `outputPrefix[n]` is the output tokens of the first `n` replies. Length `replyCount + 1`. */
  readonly outputPrefix: Float64Array;
}

export interface Scene {
  readonly model: ReplayModel;
  readonly agents: readonly AgentScene[];
  readonly byId: ReadonlyMap<ReplayAgentId, number>;
  readonly waveCount: number;
  /** Number of agents in each wave. */
  readonly waveSizes: Uint32Array;
  /** Largest final output-token count of any agent; the token arc is relative to it. */
  readonly maxOutput: number;
  readonly duration: number;
  readonly totalTools: number;
  readonly warpAt: Float64Array;
  /** For example `IDLE SKIPPED 12m30s`. */
  readonly warpLabel: readonly Label[];
  readonly warpLabelNarrow: readonly Label[];
  /** Level of detail for this model's agent count (LOD_* in lod.ts). */
  readonly lod: number;
  /** Ring summary label of each wave once it collapses, for example `WAVE 3 · 25 done`. */
  readonly waveSummary: readonly Label[];
  /** When spawn flashes and warps may start at the current speed (flash.ts, #118). */
  readonly flashes: FlashSchedule;
}

/** A 31-bit string hash. Deterministic, so a replay looks the same on every machine. */
export function hashString(text: string, seed = 7): number {
  let h = seed | 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h & 0x7fffffff;
}

/** Mix an integer into a hash. */
function mix(h: number, n: number): number {
  return (Math.imul(h ^ n, 0x9e3779b1) >>> 1) & 0x7fffffff;
}

/** Reject a replay whose format this renderer does not know. */
export function assertSupportedModel(model: ReplayModel): void {
  if (model.formatVersion !== 1) {
    throw new RangeError(`unsupported replay formatVersion: ${String(model.formatVersion)}`);
  }
  if (!Array.isArray(model.agents) || model.agents.length === 0 || model.agents[0].id !== "main") {
    throw new RangeError("replay must list the main agent first");
  }
}

export function buildScene(model: ReplayModel): Scene {
  assertSupportedModel(model);
  const nameLabels = new Map<string, Label>();
  const labelFor = (name: string): Label => {
    let label = nameLabels.get(name);
    if (label === undefined) {
      label = new Label(name, FONTS.small);
      nameLabels.set(name, label);
    }
    return label;
  };

  let waveCount = 0;
  for (const agent of model.agents) {
    if (agent.wave !== null) waveCount = Math.max(waveCount, agent.wave + 1);
  }
  const waveSizes = new Uint32Array(waveCount);
  const byId = new Map<ReplayAgentId, number>();
  let maxOutput = 0;
  let totalTools = 0;

  const agents = model.agents.map((agent, index): AgentScene => {
    byId.set(agent.id, index);
    const isMain = agent.id === "main";
    const wave = agent.wave ?? -1;
    const waveSlot = wave >= 0 ? waveSizes[wave]!++ : 0;
    const end = agent.end ?? Infinity;
    const seed = hashString(agent.id);
    const shape = shapeForFamily(agent.family);

    const n = agent.tools.length;
    totalTools += n;
    const toolStart = new Float64Array(n);
    const toolEnd = new Float64Array(n);
    const toolOpen = new Uint8Array(n);
    const toolBucket = new Uint8Array(n);
    const toolKindBucket = new Uint8Array(n);
    const toolFailed = new Uint8Array(n);
    const toolSkip = new Uint8Array(n);
    const moonCos = new Float32Array(n);
    const moonSin = new Float32Array(n);
    const moonRing = new Float32Array(n);
    const flareAngle = new Float32Array(n);
    const flareLength = new Float32Array(n);
    const toolLabel: Label[] = [];
    let maxFlareLength = 0;
    agent.tools.forEach((tool, j) => {
      toolStart[j] = tool.start;
      toolOpen[j] = tool.end === null ? 1 : 0;
      toolEnd[j] = tool.end ?? Math.max(end, tool.start);
      toolFailed[j] = tool.failed ? 1 : 0;
      toolBucket[j] = bucketFor(tool.kind, tool.failed);
      toolKindBucket[j] = bucketFor(tool.kind, false);
      toolSkip[j] = isMain && tool.kind === "agent" ? 1 : 0;
      const a = j * GOLDEN_ANGLE;
      moonCos[j] = Math.cos(a);
      moonSin[j] = Math.sin(a);
      moonRing[j] = 10 + (j % 4) * 4.2;
      const h = mix(hashString(tool.name), j);
      flareAngle[j] = isMain ? (h % 628) / 100 : ((h % 200) / 100 - 1) * 1.15;
      flareLength[j] = (isMain ? 30 : 24) + (h % 14);
      if (toolSkip[j] === 0) maxFlareLength = Math.max(maxFlareLength, flareLength[j]!);
      toolLabel.push(labelFor(tool.name));
    });

    const replyCount = agent.replies.length;
    const replyT = new Float64Array(replyCount);
    const outputPrefix = new Float64Array(replyCount + 1);
    agent.replies.forEach((reply, k) => {
      replyT[k] = reply.t;
      outputPrefix[k + 1] = outputPrefix[k]! + reply.outputTokens;
    });
    const totalOutput = outputPrefix[replyCount]!;
    maxOutput = Math.max(maxOutput, totalOutput);

    const fill = effortFill(agent.effort);
    const identityText = `${shape.family === "unknown" ? agent.family : shape.label} · ${agent.effort ?? "effort n/a"}`;
    return {
      id: agent.id,
      index,
      isMain,
      agent,
      shape,
      fill,
      maxEffort: agent.effort === "max",
      start: agent.start,
      end,
      wave,
      waveSlot,
      callsign: new Label(agent.callsign, isMain ? FONTS.main : FONTS.agent),
      callsignBold: new Label(agent.callsign, isMain ? FONTS.main : FONTS.agentBold),
      identity: new Label(identityText, FONTS.small),
      handback: new Label(`+${formatTokens(totalOutput)}`, FONTS.small),
      seed,
      toolCount: n,
      toolStart,
      toolEnd,
      toolOpen,
      toolBucket,
      toolKindBucket,
      toolFailed,
      toolSkip,
      moonCos,
      moonSin,
      moonRing,
      flareAngle,
      flareLength,
      maxFlareLength,
      toolLabel,
      replyCount,
      replyT,
      outputPrefix,
    };
  });

  const warpAt = new Float64Array(model.warps.length);
  const warpLabel: Label[] = [];
  const warpLabelNarrow: Label[] = [];
  model.warps.forEach((warp, i) => {
    warpAt[i] = warp.at;
    const text = `IDLE SKIPPED ${formatDuration(warp.skipped)}`;
    warpLabel.push(new Label(text, FONTS.warp));
    warpLabelNarrow.push(new Label(text, FONTS.warpNarrow));
  });

  const waveSummary: Label[] = [];
  for (let w = 0; w < waveCount; w++) {
    waveSummary.push(new Label(`WAVE ${w + 1} · ${waveSizes[w]} done`, FONTS.small));
  }

  return {
    model,
    agents,
    byId,
    waveCount,
    waveSizes,
    maxOutput,
    duration: Math.max(0, model.totals.duration),
    totalTools,
    warpAt,
    warpLabel,
    warpLabelNarrow,
    lod: lodFor(model.agents.length),
    waveSummary,
    flashes: createFlashSchedule(
      agents.map((a) => a.start),
      warpAt,
    ),
  };
}
