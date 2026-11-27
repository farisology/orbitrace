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

- **Keyboard:** Space plays and pauses, Left and Right scrub 5 s (30 s with Shift), Home and End
  jump to the start and end (in a running session End goes live), Escape clears the selection.
  A focused control keeps the keys it
  uses itself: Space presses a focused button, arrows move a focused slider or select. There is
  no single-letter shortcut. The first Tab stop is a "Skip to playback controls" button; Up and
  Down move between timeline lane labels; Escape closes the open session list.
- **Follow a running session:** a session the host lists as running (`busy` or `idle`) opens at
  the live edge, the newest moment, and follows it: when a new snapshot extends the timeline the
  playhead moves across the new part in at most one second (never slower than real time), so new
  calls, dispatches and handbacks are seen happening. Between snapshots it holds at the edge,
  calls still running are drawn in flight and the orrery keeps its ambient motion. Scrubbing,
  stepping, Home, pausing or choosing an earlier moment leaves follow and leaves the view paused
  there (a scrub never starts playback on its own); the Go live button and the End key return
  to follow, and playing forward into the edge follows again. The Live badge says
  "following" or how far behind the view is in real time ("Live: idle, 2 min 5 s behind"). When
  the session ends the view becomes an ordinary replay at its end; a view that was behind stays
  where it was. A `?t=` or `?paused` in the URL wins over follow for the first session shown. An
  ended session, a session with an unknown status and the demo open at the start, as before.
  A new snapshot can cut a new idle gap; the playhead is carried across it through real time, so
  a paused view stays on the same real moment and a following one never shows an earlier time.
  The controls and timeline have a fixed share of the window height, so new agents add lanes that
  scroll inside the timeline and the orrery keeps its size; while following, the newest lane is
  scrolled into view unless you scrolled the lanes yourself or it would hide the selected lane.
- **Select an agent** on the canvas or with its timeline lane label. The inspector shows its
  callsign, model family and shape, effort, wave, start and end in real time, token classes with
  a cost estimate and tool calls by kind with failures. With no agent selected it shows the
  session's tokens and estimate, by model and by agent (the ledger, from core's `sessionLedger`;
  see [docs/ledger.md](../../docs/ledger.md)).
- **Export** (header button): saves the replay on screen as a file made by core's
  `exportReplay`, with three privacy options that are off each time the dialog opens (opaque
  names, rounded times, bucketed tokens). A browser page downloads the file; an editor tab sends
  it to the extension, which asks where to save it. The extension's demo tab and the public
  replay player have no Export button. A running session is exported as it is at that moment.
- **Drop a file** anywhere on the page, or use Open file. A `.replay.json` is checked with
  `validateReplay`; a `.jsonl` transcript is parsed with `parseSession` and `buildReplay`. The
  file is read in the page and is not sent anywhere. A single transcript holds the main agent
  only; subagent transcripts are separate files and are not read. The public replay player
  (`src/player`, [docs/player.md](../../docs/player.md)) opens replay files only and refuses a
  transcript; it shows the app with `transcripts={false}`.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, or in an editor tab when the editor's
  own reduce-motion setting puts `vscode-reduce-motion` on the page body, the replay does not
  autoplay and the renderer draws still frames. A followed session still opens at the live edge;
  each new snapshot jumps the playhead to the new edge instead of moving it across.
- **Screen readers:** the canvas has a short text alternative, and a visually hidden table after
  it lists every agent with its model family and shape, who started it, whether it is running at
  the playhead and its tool calls so far. A polite live region says when a replay loads, when a
  live session changes state, when it gains agents (at most once every 10 s) and, once per
  change, when the view starts or stops following the live edge. What was
  checked, how, and what still needs a person with a screen reader is in
  [ACCESSIBILITY.md](ACCESSIBILITY.md).

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

With a host, the header has a session picker (a button that shows and hides a list): the
host's sessions (path-free summaries, newest first) with the shown one marked. A session listed as live (or with an unknown status) is
followed with `subscribe`; later snapshots go to the renderer's `updateModel`, so the selection
is kept, and the header shows a Live marker. The time is carried to the new snapshot through
real time, or moved to the new live edge while following (see Use above; the time arithmetic is
in `src/follow.ts`, the follow states in `src/clock.ts`). Both host transports deliver the same
updates, so follow works the same in an editor tab and in the browser. A session listed as ended is read once
with `loadReplay`. The picker is hidden in demo mode.

**Serving the bundle.** `npm run build` writes `dist/` with `index.html`, `assets/`,
`favicon.svg`, `orbitrace-mark.svg`, `THIRD-PARTY-NOTICES.txt` (the third-party packages in the
bundle with their licence texts) and `third-party-modules.json` (which package is in which
chunk), plus `dist/types/` (the host entry above, built by `tsc`). The CLI and the extension copy
every file except `dist/types/`. Every asset URL in `dist/` is relative (Vite `base: "./"`), chunks load
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
