# @orbitrace/app

React and Vite shell around the Orbitrace renderer: the orrery, an inspector for the selected
agent, a timeline with one lane per agent, playback controls and an event feed. Orbitrace is an
independent project and is not affiliated with Anthropic.

## Run

From the repository root, after `npm ci` and `npm run build`:

```sh
npm run dev -w @orbitrace/app       # Vite dev server on 127.0.0.1
npm run preview -w @orbitrace/app   # serve the production build in dist/
```

With no host (no editor extension, no CLI server) the app shows the bundled demo session, an
invented session from `fixtures/`.

The page URL takes `?t=<seconds>` (compressed timeline), `?select=<agent id>`,
`?speed=<1|2|4|8|16|32|64>` and `?paused`, applied to the first replay shown.

## Use

- **Keyboard:** Space (or K) plays and pauses, Left and Right scrub 5 s (30 s with Shift), Home
  and End jump to the start and end, Escape clears the selection. A focused control keeps the
  keys it uses itself: Space presses a focused button, arrows move a focused slider or select.
- **Select an agent** on the canvas or with its timeline lane label. The inspector shows its
  callsign, model family and shape, effort, wave, start and end in real time, token classes and
  tool calls by kind with failures.
- **Drop a file** anywhere on the page, or use Open file. A `.replay.json` is checked with
  `validateReplay`; a `.jsonl` transcript is parsed with `parseSession` and `buildReplay`. The
  file is read in the page and is not sent anywhere. A single transcript holds the main agent
  only; subagent transcripts are separate files and are not read.
- **Reduced motion:** with `prefers-reduced-motion: reduce` the replay does not autoplay and the
  renderer draws still frames.

## Hosts

The app talks to its host only through `HostTransport` (`src/transport.ts`, exported as
`@orbitrace/app/transport`). `App` takes a `transport` and an optional `sessionKey`; without a key
it opens the first session the host lists and follows it with `subscribe`. The package ships the
no-host transport (`createNoHostTransport`, `createDemoTransport`); the editor tab (#12) and the
browser host (#16) provide their own.

## Copied assets

The app never imports another package's files at run time. `scripts/sync-assets.mjs` copies the
demo golden replay, `design/tokens.css` and two icons into the package:

```sh
npm run sync -w @orbitrace/app        # write the copies
npm run sync:check -w @orbitrace/app  # exit 1 when a copy is out of date
```

`test/sync-assets.test.ts` fails when a copy is stale, and when a colour is written anywhere in
`src/` outside `src/generated/`.
