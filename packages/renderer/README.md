# @orbitrace/renderer

Framework-free Canvas 2D engine that draws one Orbitrace replay model as an orrery: the main
agent in the centre, subagents on one orbit per wave, tool calls as spokes while they run and
moons once they finish.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** This package is not on npm yet. Build it from the
[repository](https://github.com/farisology/orbitrace). It depends on `@orbitrace/core` at run
time and ships compiled JavaScript and type declarations only; the `src/` paths below are in the
repository, not in the package.

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

The full contract is
[`src/api.ts`](https://github.com/farisology/orbitrace/blob/main/packages/renderer/src/api.ts). Points that the types do not say:

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
| `src/hit.ts`              | Agent under a point                                             | yes             |
| `src/draw.ts`             | Paints a frame on any `DrawContext`                             | takes a context |
| `src/orrery.ts`           | Canvas, pointer input and frame scheduling                      | no              |
| `src/generated/design.ts` | Colours, fonts and node shapes from `design/`                   | generated       |

The hot path (`computeFrameState` and `drawFrame`) allocates nothing per frame;
`test/allocation.test.ts` checks this with V8's sampling heap profiler.

## Commands

Run from `packages/renderer`, after `npm run build` at the repository root:

```sh
npm run dev             # demo page with a synthetic session (Vite, 127.0.0.1)
npm run generate        # regenerate src/generated/design.ts from design/*.json
npm run generate:check  # exit 1 when the generated module is out of date
npm run bench:browser   # run the demo benchmark in headless Chrome (CHROME_PATH to override)
```

The demo page takes `?t=<seconds>`, `?select=<agent id>`, `?paused` and `?bench=1`. All demo
data is invented by a seeded generator in `demo/demo-model.ts`.

## Licence

MIT. See [LICENSE](LICENSE).
