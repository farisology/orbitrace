# @orbitrace/renderer

Framework-free Canvas 2D engine that draws one Orbitrace replay model as an orrery: the main
agent in the centre, subagents on one orbit per wave, tool calls as spokes while they run and
moons once they finish. Orbitrace is not affiliated with Anthropic.

## Use

```ts
import { createOrrery } from "@orbitrace/renderer";

const orrery = createOrrery(canvas, { reducedMotion: false });
orrery.resize(canvas.clientWidth, canvas.clientHeight);
orrery.setModel(model); // a ReplayModel from @orbitrace/core
orrery.on("select", ({ agentId }) => orrery.select(agentId));
orrery.setSpeed(8);
orrery.play();
// The host owns the clock: call setTime(t) every frame while playing.
```

The full contract is `src/api.ts`. Points that the types do not say:

- The renderer never advances replay time. `play`, `pause` and `setSpeed` only start, stop and
  scale motion that is not tied to replay time. Effects with a real-time length (comets, reply
  pulses, the minimum visible time of short calls, the warp after an idle skip) are computed
  from the time and the speed, so a paused host freezes them.
- Reduced motion draws one still frame per change: no comets, pulses, flashes, fades, warp
  streaks or ambient motion, and no frame loop. The scrubber still works. The default is the
  user's `prefers-reduced-motion` setting, read once when the renderer is created.
- `minVisibleCallSeconds` defaults to 0.3 real seconds.
- A family outside `KNOWN_MODEL_FAMILIES` is drawn as a circle; a call's colour comes from its
  `kind`. A failed call takes the failure colour once its result is in.
- `createOrreryWithEnvironment(canvas, options, environment)` takes an injected frame scheduler,
  pixel ratio and sprite surfaces, for tests and hosts that schedule frames themselves.

## Structure

| File                      | Role                                                            | Pure            |
| ------------------------- | --------------------------------------------------------------- | --------------- |
| `src/scene.ts`            | Flattens a model into typed arrays once per model               | yes             |
| `src/layout.ts`           | Orbit and node positions per canvas size                        | yes             |
| `src/timeline.ts`         | State at time `t`: phases, calls in flight, token arcs, effects | yes             |
| `src/label-layout.ts`     | Where each label goes so that no two overlap                    | yes             |
| `src/lod.ts`              | Level of detail by agent count; ring summaries of done waves    | yes             |
| `src/hit.ts`              | Agent under a point                                             | yes             |
| `src/draw.ts`             | Paints a frame on any `DrawContext`                             | takes a context |
| `src/orrery.ts`           | Canvas, pointer input and frame scheduling                      | no              |
| `src/generated/design.ts` | Colours, fonts and node shapes from `design/`                   | generated       |

The hot path (`computeFrameState` and `drawFrame`, label placement included) allocates nothing
per frame; `test/allocation.test.ts` checks this with V8's sampling heap profiler at 100 and 500
agents.

An agent's phase comes from core's `agentPhase` (#108): running in `[start, end)`, finished
from `end` on, the same rule the app's inspector uses.

Labels never overlap: the main agent's label, the selected and hovered agents' labels (always
shown), the wave labels, then running agents' labels, then finished ones, each placed at the
first free spot around its node or dropped. Above 100 agents the level of detail leaves out
moons, caps the labels and collapses finished waves into ring summaries. The thresholds, the
budget and the measurements are in [docs/performance.md](../../docs/performance.md).

## Commands

Run from `packages/renderer`, after `npm run build` at the repository root:

```sh
npm run dev             # demo page with a synthetic session (Vite, 127.0.0.1)
npm run generate        # regenerate src/generated/design.ts from design/*.json
npm run generate:check  # exit 1 when the generated module is out of date
npm run bench:browser   # draw benchmark at 15, 100, 500 agents in headless Chrome
npm run bench:node      # draw path and parse/build benchmarks in Node (50 MB transcript included)
```

`bench:browser` takes `CHROME_PATH`, `BENCH_DPR` (default 2), `BENCH_CPU_THROTTLE` (default 1)
and `BENCH_AGENTS` (default `15,100,500`).

The demo page takes `?t=<seconds>`, `?select=<agent id>`, `?paused`, `?session=large` (100
agents) or `?session=huge` (500 agents), and `?bench=1` (with `&agents=15,100`). Every session
on it is synthetic: `demo/sessions.ts` scripts a transcript with the seeded generator in
`@orbitrace/fixtures` and runs it through core's real `parseSession` and `buildReplay` (#77); the
live mode asks `buildReplay` for snapshots with `now` and `previous`, as a host does.
