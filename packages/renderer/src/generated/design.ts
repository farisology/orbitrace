// Generated from design/tokens.json and design/model-shapes.json by
// packages/renderer/scripts/generate-design.mjs. Do not edit by hand: run `npm run generate`
// in packages/renderer. test/design.test.ts fails when this file is out of date.

/** Every colour token, flattened from its group. */
export const DESIGN_COLORS = {
  void: "#060714",
  deck: "#0C0E22",
  panel: "#111431",
  rim: "#23284F",
  "rim-hi": "#343B72",
  text: "#E4E7FA",
  dim: "#9BA1C9",
  faint: "#8890BE",
  ion: "#6E95FF",
  bench: "#3EE0C0",
  wire: "#B48CFF",
  pulse: "#FFC65A",
  tape: "#FF72A6",
  ledger: "#FF8C4E",
  rig: "#7FD8FF",
  fault: "#FF5A6E",
  ok: "#5BE39A",
} as const;

/** CSS font stacks by role. */
export const DESIGN_FONTS = {
  display:
    '"Chakra Petch", "Eurostile", "Bank Gothic", "Avenir Next Condensed", system-ui, sans-serif',
  body: '"IBM Plex Sans", "Helvetica Neue", "Arial", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", "Menlo", monospace',
} as const;

/** Node outline per model family, for radius 1 centred on (0, 0), y down. `null` points: circle. */
export const FAMILY_SHAPES = {
  fable: {
    label: "Fable",
    shape: "eight-point burst",
    points: [
      [0, -1.22],
      [0.3291, -0.7945],
      [0.8627, -0.8627],
      [0.7945, -0.3291],
      [1.22, 0],
      [0.7945, 0.3291],
      [0.8627, 0.8627],
      [0.3291, 0.7945],
      [0, 1.22],
      [-0.3291, 0.7945],
      [-0.8627, 0.8627],
      [-0.7945, 0.3291],
      [-1.22, 0],
      [-0.7945, -0.3291],
      [-0.8627, -0.8627],
      [-0.3291, -0.7945],
    ],
    core: [0, 0],
  },
  opus: {
    label: "Opus",
    shape: "hexagon",
    points: [
      [0, -1.1],
      [0.9526, -0.55],
      [0.9526, 0.55],
      [0, 1.1],
      [-0.9526, 0.55],
      [-0.9526, -0.55],
    ],
    core: [0, 0],
  },
  sonnet: {
    label: "Sonnet",
    shape: "diamond",
    points: [
      [0, -1.18],
      [1.18, 0],
      [0, 1.18],
      [-1.18, 0],
    ],
    core: [0, 0],
  },
  haiku: {
    label: "Haiku",
    shape: "triangle",
    points: [
      [0, -1.12],
      [1.1258, 0.83],
      [-1.1258, 0.83],
    ],
    core: [0, 0.18],
  },
  unknown: {
    label: "Unknown",
    shape: "circle",
    points: null,
    core: [0, 0],
  },
} as const;

/** Inner fill fraction per effort level. */
export const EFFORT_FILL = {
  low: 0,
  medium: 0.4,
  high: 0.6,
  xhigh: 0.8,
  max: 1,
} as const;

/** Fill used when the effort is not recorded. */
export const UNKNOWN_EFFORT_FILL = 0.25;

/** The inner shape is the outer shape scaled by `scaleBase + scaleSpan * fill`. */
export const INNER_SCALE = {
  scaleBase: 0.25,
  scaleSpan: 0.6,
} as const;

/** White dot drawn at max effort, at the family's core point. */
export const WHITE_CORE = {
  color: "#FFFFFF",
  radius: 0.1467,
} as const;
