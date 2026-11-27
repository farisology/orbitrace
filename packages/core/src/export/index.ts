/** Ticket #18: structure-only replay export and replay v1 validation. */
export { applyExportOptions, exportReplay, REPLAY_EXPORT_FILE_NAME } from "./export-replay.js";
export {
  assertReplay,
  describeReplayProblems,
  MAX_REPORTED_PROBLEMS,
  ReplayValidationError,
  validateReplay,
} from "./validate.js";
/** Tickets #122 and #123: the opt-in export options. */
export {
  changesOutput,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_NAMES,
  isExportNames,
  isRoundTimesStep,
  resolveExportOptions,
  ROUND_TIMES_MAX_STEP,
  ROUND_TIMES_MIN_STEP,
  type ResolvedExportOptions,
} from "./options.js";
export {
  isKnownModelId,
  OPAQUE_AGENT_PREFIX,
  OPAQUE_KEPT_TOOL_NAMES,
  OPAQUE_MCP_PREFIX,
  OPAQUE_TOOL_PREFIX,
  opaqueNames,
} from "./opaque-names.js";
export { bucketReplayTokens, bucketTokenCount, roundReplayTimes, roundToStep } from "./coarsen.js";
