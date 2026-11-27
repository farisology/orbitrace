# Performance

The budget the renderer and the replay pipeline are held to, what was measured against it, the
level-of-detail rule that keeps large sessions drawable, and what has not been measured. Ticket
#14. Every number here comes from a synthetic session made by the seeded generator in
`@orbitrace/fixtures` and run through core's real `parseSession` and `buildReplay`; none comes
from a real session.

## Budget

| What                                              | Budget                                                         | Checked by                                       |
| ------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| Frame rate at up to 100 agents                    | 60 fps in Chrome: every frame within 16.7 ms after start-up    | `npm run bench:browser`                          |
| Renderer main-thread time per frame at 100 agents | p95 at most 4 ms, with the CPU slowed 4 times                  | `npm run bench:browser` (`BENCH_CPU_THROTTLE=4`) |
| Allocation on the hot path                        | none: under 4096 bytes over 8000 frames, at 100 and 500 agents | `test/allocation.test.ts` (part of `npm test`)   |
| Parse and build of a 50 MB transcript             | at most 2 s and 500 MB peak memory                             | `npm run bench:node`                             |
| Above 100 agents                                  | degrade in fixed steps by agent count, never by frame time     | `test/lod.test.ts`                               |

The 4 ms share leaves the rest of a 16.7 ms frame to the browser's raster and compositing and to
the app's own panels. A slowed CPU stands in for a slower laptop than the reference machine.

## Measurements

Reference machine: Apple M1 Pro, 8 cores, 16 GB, macOS 27.0, Node v26.5.0, Chrome 158 headless
(GPU raster, not software). Measured on 27 Nov 2026.

Sessions: the bundled `demo` scenario (15 agents, 208 tool calls, 4 waves), and
`scaledSession(100)` and `scaledSession(500)` from `packages/renderer/demo/sessions.ts`
(subagents in waves of 25: 100 agents with 1,064 calls in 4 waves, 500 agents with 5,402 calls
in 20 waves).

"Before" is the renderer on `dev` before this change; "after" is this change. Both ran with the
same benchmark code.

### Draw path in headless Chrome

Command, in `packages/renderer` after `npm run build` at the root:

```sh
BENCH_DPR=2 npm run bench:browser
BENCH_DPR=2 BENCH_CPU_THROTTLE=4 npm run bench:browser
```

Canvas 1280 by 730 CSS pixels at device pixel ratio 2. "Engine" is the main-thread time of
`computeFrameState` + `drawFrame` and the canvas calls they make, over 600 frames driven
synchronously across the whole session. "Frame rate" is `createOrrery` playing the whole session
in 5 seconds under `requestAnimationFrame`; a long frame is an interval over 20 ms.

| Agents | CPU | Engine p50 / p95 before | Engine p50 / p95 after | fps before | fps after | Long frames before | Long frames after |
| ------ | --- | ----------------------- | ---------------------- | ---------- | --------- | ------------------ | ----------------- |
| 15     | 1x  | 0.1 / 0.2 ms            | 0.1 / 0.2 ms           | 56.4       | 56.2      | 1 (frame 0)        | 1 (frame 0)       |
| 100    | 1x  | 0.4 / 0.7 ms            | 0.4 / 0.7 ms           | 60.0       | 60.0      | 0                  | 0                 |
| 500    | 1x  | 1.4 / 2.8 ms            | 0.2 / 0.4 ms           | 59.6       | 60.0      | 2                  | 0                 |
| 15     | 4x  | 0.5 / 1.1 ms            | 0.5 / 1.1 ms           | 49.8       | 49.4      | 1 (frame 0)        | 2 (frames 0, 1)   |
| 100    | 4x  | 1.5 / 2.7 ms            | 1.6 / 2.8 ms           | 60.0       | 59.8      | 0                  | 1 (frame 0)       |
| 500    | 4x  | 6.2 / 13.5 ms           | 0.9 / 1.7 ms           | 47.8       | 60.0      | 61                 | 0                 |

Reading the table:

- 100 agents meets the budget with and without the slowed CPU: 60 fps, engine p95 2.8 ms at 4x.
- The 15-agent case runs first on a fresh page, so its first frame carries the page's start-up
  (300 to 900 ms: fonts, sprites, the first raster). That one interval lowers the 5-second
  average; every later interval is 16.7 ms. The 100-agent long frame at 4x is the same start-up
  frame of a new renderer.
- At 500 agents and a 4x slower CPU the old renderer dropped to 48 fps with 61 long frames. The
  level of detail brings it back to 60 fps with none.
- The engine's single slowest frame (not in the table) is 70 to 500 ms in both versions, one
  frame per case. It appears only in the synchronous loop, which gives the browser no time to
  flush between frames, and never as a long interval under `requestAnimationFrame`.

### Draw path in Node

Command: `npm run bench:node` in `packages/renderer` (file `perf/draw.perf.ts`). A canvas
1080 by 530 (the app's orrery at a 1440 by 900 window), 1200 frames across the session. Node has
no canvas: a no-op context gives the JavaScript cost, and a counting context counts the canvas
calls a frame asks for, a stand-in for raster work.

| Agents | Level   | JS per frame p50 / p95 before | after            | Canvas calls p50 / max before | after         |
| ------ | ------- | ----------------------------- | ---------------- | ----------------------------- | ------------- |
| 15     | full    | 0.026 / 0.050 ms              | 0.028 / 0.032 ms | 891 / 1,134                   | 892 / 1,135   |
| 100    | full    | 0.077 / 0.122 ms              | 0.115 / 0.180 ms | 2,802 / 4,996                 | 2,803 / 4,997 |
| 500    | minimal | 0.312 / 0.524 ms              | 0.127 / 0.172 ms | 12,193 / 22,705               | 2,455 / 4,913 |

At 100 agents label placement (with node avoidance) adds about 0.04 ms per frame. At 500 agents
the peak number of arcs per frame falls from 6,026 to 1,300 and of text draws from 549 to 31.

### Wave labels on their rings (#128)

Placing the wave labels on their rings clear of nodes, arcs and beams (see Labels below) costs
a little on top. Measured on the reference machine on 27 Nov 2026, the renderer on `dev` before
#128 against #128, same benchmark code, in the same session:

| Agents | Node p50 / p95 before | after            | Chrome engine p50 / p95 at 4x CPU before | after        |
| ------ | --------------------- | ---------------- | ---------------------------------------- | ------------ |
| 15     | 0.028 / 0.033 ms      | 0.031 / 0.038 ms | 0.6 / 1.1 ms                             | 0.6 / 1.2 ms |
| 100    | 0.120 / 0.187 ms      | 0.131 / 0.227 ms | 1.8 / 3.1 ms                             | 1.9 / 3.3 ms |
| 500    | 0.123 / 0.170 ms      | 0.175 / 0.348 ms | 1.0 / 2.0 ms                             | 1.3 / 2.6 ms |

Chrome at 1x and the frame rate are unchanged within a tenth of a millisecond: 60 fps at 100 and
500 agents, with and without the slowed CPU. The 100-agent p95 at 4x stays inside the 4 ms
budget. Most frames only check the spot each wave label holds; the p95 is the frames in which a
label looks for a new spot. Both builds were measured within the same afternoon; the "before" column
of the tables above is from an earlier session and reads lower on this machine (2.8 ms there
against 3.1 ms here for the same build). Runs of the same build vary by about 0.3 ms at p95.

### Parse and build

Command: `npm run bench:node` (file `perf/pipeline.perf.ts`).

In memory (lines already split, no file reading):

| Agents | Lines  | Transcript | Parse   | Build   |
| ------ | ------ | ---------- | ------- | ------- |
| 15     | 549    | 0.4 MB     | 2.4 ms  | 3.3 ms  |
| 100    | 2,723  | 2.0 MB     | 10.0 ms | 6.1 ms  |
| 500    | 13,838 | 10.4 MB    | 49.9 ms | 28.6 ms |

A 50 MB transcript: the generator writes a 100-agent session with 152 tool rounds per agent
(50.7 MiB in 199 files, 67,592 lines, 28,082 tool calls) to a new temporary folder laid out like
a Claude Code config folder. A child process (`scripts/parse-build-child.mjs`) reads it back
through the Claude Code adapter (`listSessions`, `openSession`), `parseSession` and
`buildReplay`. Three runs; the folder is deleted afterwards.

| Step                             | Median of 3 runs | Runs             |
| -------------------------------- | ---------------- | ---------------- |
| Open and parse (reads the files) | 310 ms           | 310, 394, 308 ms |
| Build                            | 58 ms            | 63, 54, 58 ms    |
| Peak memory of the process (RSS) | 157 MB           | 157, 166, 156 MB |

Resident memory starts at about 50 MB (Node itself), is about 108 MB after parsing and about
157 MB after building. Parse and build are well inside the budget, so the parser and builder are
unchanged.

## Level of detail

The level is chosen once per model from its agent count, main agent included (`src/lod.ts`).
So a session looks the same every time it is shown at a given size, and the drawing degrades in
fixed steps rather than by frame time.

| Level                   | Agents                                | What is drawn                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full (`LOD_FULL`)       | up to 100 (`LOD_FULL_MAX_AGENTS`)     | Everything. No label cap besides collisions; labels also avoid covering other nodes.                                                                                                                           |
| Reduced (`LOD_REDUCED`) | 101 to 250 (`LOD_REDUCED_MAX_AGENTS`) | Finished agents drop their moons (the call count stays in the detail row); no fresh-moon glow; at most 24 agent labels (`LABEL_BUDGET`) besides the selected and hovered ones; labels avoid other labels only. |
| Minimal (`LOD_MINIMAL`) | over 250                              | As reduced, and running agents drop their moons too; no tool-name tags beside spokes; at most 12 agent labels; every wave whose agents have all finished collapses into a ring summary.                        |

A ring summary draws the wave's orbit as one solid ring with the label `WAVE n · k done`, and
its agents as plain dots with no tether, token arc, reply pulse or label. A wave with any agent
still running or not yet started never collapses.

At every level:

- the selected and hovered agents are drawn in full, moons and detail row included, and their
  labels are always shown;
- tool calls in flight (spokes), comets, halos, token arcs of uncollapsed agents and the warp
  effect are kept;
- hit testing, selection and the timeline are unchanged: a collapsed agent can still be
  hovered and selected, and it is then drawn in full;
- nothing allocates per frame (`test/allocation.test.ts` runs at 100 and 500 agents).

## Labels

`src/label-layout.ts` places labels so that none overlap; it is pure and allocation-free.

1. The main agent's label, then the selected agent's, then the hovered agent's, are always
   placed (with the selected and hovered detail rows).
2. Wave labels sit on their own ring, centred on it, at one of 72 angles (#128). Each angle is
   scored against what the frame draws there: nodes with their token arc, orbit dash and
   reticle, moons, and at full detail tool beams and spoke tags count as hits; agent slots,
   the reach of running agents' beams and tethers as soft costs. A label keeps its angle while
   that spot gets no more hits than when it took it, and otherwise moves to the free angle with
   the fewest hits, fading across in 0.3 s while the clock runs (at once when paused). Angles
   that cover a label already placed, another wave label or the canvas edge are ruled out. A
   wave label is shown at every canvas size and only left out when no angle on its ring is free
   of labels and edges. Wave labels are drawn after every node, beam and comet, over a backing
   box that hides the ring line under the text.
3. Running subagents, then finished ones, in id order, each try four spots around their node:
   outward from the centre (the old fixed spot), inward, right, left. At full detail a spot must
   also cover no other node; if none does, any spot that avoids labels is taken. A label with no
   free spot, or over the budget, is dropped. Finished agents only want a label when nothing is
   running (as before), so they give way first.

`test/label-layout.test.ts` checks, on the demo golden replay at 14 times and 5 canvas sizes
with several selections, that no two placed boxes overlap and that the main, selected and
hovered labels are shown; and at 100 and 500 agents that the budget holds. For wave labels it
checks, at 7 canvas sizes including the app's orrery at 1440 by 900 and 1280 by 800, that every
wave label is shown on its ring, that none covers a node, token arc or beam (measured apart from
the placement code), and over a played run that a label only moves when its spot is hit or
blocked.

## Not measured

- A real browser window on a display. Every browser number is headless Chrome; a window adds
  compositing with the rest of the desktop. Check visually in the app as well.
- Firefox, Safari, the VS Code webview, Windows and Linux.
- A low-end or integrated GPU, a 4K canvas, and battery use.
- The app shell: the benchmark draws on the renderer's demo page, without the app's React
  panels (timeline, event feed, inspector).
- Live view at scale: the cost of `buildReplay(..., { previous })` and `updateModel` (which
  rebuilds the scene) per snapshot at 500 agents.
- Parsing a 50 MB file dropped into the browser; the 50 MB numbers are Node only.
- Sessions over 500 agents or a single agent with tens of thousands of calls. Moons per agent are
  capped at 400 (`MAX_MOONS_PER_AGENT`) at every level.
- Spoke tags and comet tags are not part of agent label placement and can still overlap an
  agent label. Wave labels avoid spoke tags at full detail, using an estimate of the tag's width.
