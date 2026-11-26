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
`@orbitrace/app/transport`). Hosts serve the built bundle (`@orbitrace/app/dist/*`); they do not
import the React app. The wire layout both sides share (meta tag names, fragment parameters,
routes, request and message checks) is in `src/protocol.ts`, built as plain JavaScript and
exported as `@orbitrace/app`.

**Start-up selection** (`src/startup.ts`, run by `src/main.tsx` before React renders):

1. `<meta name="orbitrace-host" content="editor">` selects the editor webview transport
   (`src/webview-transport.ts`): requests go out with `acquireVsCodeApi().postMessage`, replies
   and live updates come back as window `message` events. An optional
   `<meta name="orbitrace-session" content="<session key>">` preselects a session.
2. Otherwise a token in the page fragment, `#t=<token>&key=<session key>`, selects the loopback
   HTTP transport (`src/http-transport.ts`). The fragment is removed from the address bar with
   `history.replaceState` before any request. Every request sends `Authorization: Bearer
<token>` and no cookies: `POST /api/rpc` for one request and reply, `POST /api/live` for a
   subscription answered as newline-delimited JSON (aborting the request unsubscribes). URLs are
   origin-relative. The token is never put in a URL, in storage or in a log, so reloading the
   page starts the demo; open the link again.
3. Otherwise the bundled demo.

When a host lists no sessions the app shows the demo and says so. When the host refuses the
token, or the session list cannot be read, the app shows a plain error page instead.

With a host, the header has a session picker: the host's sessions (path-free summaries, newest
first) with the shown one marked. A session listed as live (or with an unknown status) is
followed with `subscribe`; later snapshots go to the renderer's `updateModel`, so the selection
and time are kept, and the header shows a Live marker. A session listed as ended is read once
with `loadReplay`. The picker is hidden in demo mode.

**Serving the bundle.** Every asset URL in `dist/` is relative (Vite `base: "./"`), chunks load
relative to the script, and there is no inline script, style or event handler, so a
Content-Security-Policy with `script-src` limited to the bundle works. In an editor webview, put
a `<base href>` pointing at the bundle folder's webview URI into `index.html`, with the meta
tags. `test/bundle.test.ts` checks the built output.

## Copied assets

The app never imports another package's files at run time. `scripts/sync-assets.mjs` copies the
demo golden replay, `design/tokens.css` and two icons into the package:

```sh
npm run sync -w @orbitrace/app        # write the copies
npm run sync:check -w @orbitrace/app  # exit 1 when a copy is out of date
```

`test/sync-assets.test.ts` fails when a copy is stale, and when a colour is written anywhere in
`src/` outside `src/generated/`.
