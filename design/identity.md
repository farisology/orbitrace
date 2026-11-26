# Orbitrace identity

How Orbitrace looks, and the rules for using it. The values live in data files, not in this text.

| file | what it holds | edit by hand? |
|---|---|---|
| `tokens.json` | colours, font stacks, spacing, radius | yes, this is the source |
| `tokens.css` | the same values as CSS custom properties on `:root` | no, generated |
| `model-shapes.json` | node polygon per model family, effort fill fractions | no, generated |
| `icons/orbitrace-mark.svg` | the mark, full colour | yes |
| `icons/activity-bar.svg` | 24 px one-colour icon for the editor activity bar | yes |
| `icons/favicon.svg` | the mark on a dark tile, heavier strokes | yes |
| `scripts/build-tokens.mjs` | generates the files above and the contrast tables in this file | yes |

After changing `tokens.json` or the shape geometry, run from the repository root:

```sh
node design/scripts/build-tokens.mjs           # regenerate
node design/scripts/build-tokens.mjs --check   # exit 1 if anything is stale or below 4.5:1
```

The script has no dependencies and needs Node 20 or later.

Nothing in the repository uses these tokens yet. The renderer and app packages are later tickets.

## Theme

One dark theme: deep-space grounds, light text, saturated signal colours. There is no light theme. `tokens.css` sets `color-scheme: dark`.

## Colours

CSS name is `--<token>`, for example `var(--ion)`.

### Grounds

| token | value | use |
|---|---|---|
| `void` | `#060714` | page and orrery canvas background |
| `deck` | `#0C0E22` | bars, strips, code backgrounds, finished-agent node fill |
| `panel` | `#111431` | cards, inspector, buttons, active-agent node fill |
| `rim` | `#23284F` | borders and dividers; also the most raised ground text may sit on |

`rim-hi` `#343B72` (group `line`) is the hover and control border. It is not a text ground.

### Text

| token | value | use |
|---|---|---|
| `text` | `#E4E7FA` | body text, headings, values |
| `dim` | `#9BA1C9` | secondary text, labels, captions |
| `faint` | `#8890BE` | the quietest text: hints, timestamps, labels of finished agents |

Changed from the concept prototype: `faint` was `#5C628F`. It measured 3.43:1 on `void`, 3.27 on `deck`, 3.08 on `panel` and 2.42 on `rim`, below the 4.5:1 AA minimum on every ground. It is now `#8890BE`, which passes on all four (4.56 on `rim`, the hardest case). The cost is a smaller step between `dim` and `faint`. Where the old darker look is wanted for a non-text mark, such as a finished agent's fill on the canvas, lower the opacity instead of adding a darker text token.

### Brand

`ion` `#6E95FF` is the Orbitrace colour: the orbit ring in the mark, links, focus outlines, selected and pressed states, and the main agent at the centre of the orrery.

### Dimensions

The concept page groups the product into six dimensions, each with one colour. Use a dimension's colour for that dimension everywhere: its section accent, its headings, its charts.

| token | value | dimension |
|---|---|---|
| `bench` | `#3EE0C0` teal | Bench: work |
| `wire` | `#B48CFF` violet | Wire: communication |
| `pulse` | `#FFC65A` amber | Pulse: activity |
| `tape` | `#FF72A6` pink | Tape: messages |
| `ledger` | `#FF8C4E` orange | Ledger: cost |
| `rig` | `#7FD8FF` cyan | Rig: setup |

The orrery reuses these colours for tool calls and events. This mapping comes from the concept prototype:

| in the orrery | token |
|---|---|
| shell calls (`Bash`) | `pulse` |
| read calls, MCP calls, and any other tool | `rig` |
| edit and write calls | `bench` |
| agent calls, dispatch comet, subagent node outline and effort fill | `wire` |
| handback comet | `bench` |
| output-token arc around a node | `ledger` |
| failed call | `fault` |

### Status

| token | value | use |
|---|---|---|
| `fault` | `#FF5A6E` | failures and errors only; never decoration |
| `ok` | `#5BE39A` | success, completed |

### Colour rules

- Colour is never the only signal. Pair it with a label, an icon or a shape. The model family is carried by shape for this reason.
- Body text uses `text` or `dim`. Signal colours are for short labels, headings, values and marks, not paragraphs.
- Text sits on `void`, `deck`, `panel` or `rim` only. Every text, brand, dimension and status colour passes 4.5:1 on all four (tables below).
- `rim` and `rim-hi` borders are low contrast (`rim` 1.42:1 and `rim-hi` 1.92:1 on `void`). They separate areas; they must not be the only thing that shows where a control is or what state it is in. Focus uses a 2 px `ion` outline (7.07:1 on `void`).

## Type

| role | token | stack | use |
|---|---|---|---|
| display | `--font-display` | Chakra Petch, Eurostile, Bank Gothic, Avenir Next Condensed, system-ui, sans-serif | headings and the wordmark, uppercase, bold |
| body | `--font-body` | IBM Plex Sans, Helvetica Neue, Arial, system-ui, sans-serif | running text |
| mono | `--font-mono` | IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace | numbers (with `font-variant-numeric: tabular-nums`), labels, agent callsigns, canvas text |

The tokens name the fonts but do not load them. No font files are bundled yet, so the system fallbacks are what renders until a later ticket adds them. The prototype named these `--f-display`, `--f-body` and `--f-mono`; they are renamed to `--font-*`.

## Spacing and radius

| token | px |
|---|---|
| `--space-1` | 4 |
| `--space-2` | 8 |
| `--space-3` | 12 |
| `--space-4` | 16 |
| `--space-5` | 24 |
| `--space-6` | 32 |
| `--space-7` | 48 |
| `--space-8` | 64 |

| token | px | use |
|---|---|---|
| `--radius-none` | 0 | default for panels, cards, buttons (the console look is square) |
| `--radius-sm` | 2 | small chips and pills |
| `--radius-md` | 4 | tooltips, popovers |
| `--radius-lg` | 8 | dialogs |
| `--radius-round` | 9999 | dots, avatars, fully round pills |

Both scales are new; the prototype used ad hoc `rem` values and square corners.

## Shape and effort

Every agent node encodes two things without text: the outline shape is the model family, the inner fill is the effort level. The family is the word after `claude-` in the model id (`claude-opus-5-5` is Opus). Exact points are in `model-shapes.json`.

| family | shape | outer radius |
|---|---|---|
| Fable | eight-point burst: 16 points alternating 1.22 and 0.86 | 1.22 |
| Opus | hexagon, point up | 1.1 |
| Sonnet | diamond | 1.18 |
| Haiku | triangle, point up, moved down by 0.18 so it sits optically centred | 1.3 |
| unknown | circle | 1 |

The outer radii are the prototype's values. They differ by family so that the shapes look about the same size next to each other; they are not all 1.

| effort | fill | look |
|---|---|---|
| low | 0 | hollow: outline only |
| medium | 0.4 | small inner shape |
| high | 0.6 | medium inner shape |
| xhigh | 0.8 | large inner shape |
| max | 1 | largest inner shape, plus a white core |
| not recorded | 0.25 | between low and medium |

How to draw a node of radius `r`:

1. Fill the outer shape with `panel` and stroke it with `wire` (`ion` for the main agent). Once the agent has finished, fill with `deck` and stroke with `rim-hi`.
2. If fill is above 0, draw the same shape scaled about the node centre by `0.25 + 0.6 * fill` and fill it with the stroke colour (`faint` at reduced opacity once finished). At max that is 0.85 of the outer shape.
3. At max effort, draw a white dot of radius `0.1467 * r` at the family's `core` point. For Haiku the core point is `(0, 0.18)`, the centre of the moved triangle.

The white core is a marker, not text, so the 4.5:1 rule does not apply. It measures 2.58:1 against `wire`.

## Mark and icons

The mark is an orbit ring that forms the O, a lowercase t drawn as a circuit trace inside it, and one satellite on the ring. O and t: orbit and trace. The ring is open where the satellite sits, so the satellite needs no outline and the mark works on any background colour the trace is visible on.

| file | colours | made for |
|---|---|---|
| `orbitrace-mark.svg` | ring `ion`, trace `text`, satellite `bench`, transparent background | dark backgrounds, 24 px and up |
| `favicon.svg` | same colours on a `void` tile with 10/48 corner radius; thicker strokes; the trace has no end pad | browser tabs, 16 to 48 px, light or dark browser chrome |
| `activity-bar.svg` | `currentColor` only, transparent background | the editor activity bar at 24 px; the host sets the colour |

Rules:

- Keep clear space around the mark of at least a quarter of its width.
- Do not recolour, rotate, stretch, outline or add effects to the mark. The glow in the prototype is a UI effect, not part of the mark.
- The trace is near white, so the full-colour mark disappears on white. On light backgrounds use `favicon.svg` (it carries its own dark tile) or `activity-bar.svg` with a dark `color`.
- Below 24 px use `favicon.svg`; its strokes are drawn for that size.
- The mark is original work for this project. It is not traced from the prototype's letter mark or any other logo.
- Write the name as "Orbitrace". Refer to Claude Code descriptively and state that Orbitrace is not affiliated with Anthropic.

## Contrast

WCAG 2.2 contrast ratio from relative luminance, computed by `scripts/build-tokens.mjs` from the values in `tokens.json`. AA for body text is 4.5:1.

<!-- contrast:start (generated by design/scripts/build-tokens.mjs, do not edit by hand) -->
Text colours:

| token | void `#060714` | deck `#0C0E22` | panel `#111431` | rim `#23284F` |
|---|---:|---:|---:|---:|
| `--text` `#E4E7FA` | 16.32 | 15.53 | 14.65 | 11.50 |
| `--dim` `#9BA1C9` | 7.95 | 7.57 | 7.13 | 5.60 |
| `--faint` `#8890BE` | 6.47 | 6.15 | 5.80 | 4.56 |

Brand, dimension and status colours, for labels, headings and links set in these colours:

| token | void `#060714` | deck `#0C0E22` | panel `#111431` | rim `#23284F` |
|---|---:|---:|---:|---:|
| `--ion` `#6E95FF` | 7.07 | 6.72 | 6.34 | 4.98 |
| `--bench` `#3EE0C0` | 12.05 | 11.46 | 10.81 | 8.49 |
| `--wire` `#B48CFF` | 7.76 | 7.39 | 6.96 | 5.47 |
| `--pulse` `#FFC65A` | 12.86 | 12.23 | 11.54 | 9.06 |
| `--tape` `#FF72A6` | 7.83 | 7.45 | 7.03 | 5.52 |
| `--ledger` `#FF8C4E` | 8.69 | 8.27 | 7.80 | 6.12 |
| `--rig` `#7FD8FF` | 12.56 | 11.95 | 11.27 | 8.85 |
| `--fault` `#FF5A6E` | 6.62 | 6.30 | 5.94 | 4.66 |
| `--ok` `#5BE39A` | 12.31 | 11.71 | 11.04 | 8.67 |
<!-- contrast:end -->

Not measured: text on `rim-hi`, text on translucent overlays and gradients, and canvas text drawn over glows or at reduced opacity. Finished agents in the prototype draw their inner fill in `faint` at 55% opacity; any text drawn at reduced opacity needs its own check.
