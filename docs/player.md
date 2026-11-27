# Public replay player

**Status: built, not published.** The player builds from `packages/app` and a manual workflow
can package it for GitHub Pages, but Pages is not turned on and nothing is hosted yet.

The player is a static web page that opens a shared Orbitrace replay file (`.replay.json`) and
shows it in the same orrery, timeline, inspector and event feed as the app. It has no server
part: any static host can serve it, from any folder.

Orbitrace is an independent project and is not affiliated with Anthropic.

## What a visitor sees

- A start screen that asks for a replay file: an **Open a replay file** button, or drop the file
  anywhere on the page.
- **Watch the demo**: the bundled demo replay, built from a synthetic session. It shows only when
  the visitor picks it.
- One line on making a replay of your own session: run `orbitrace export --latest -o
session.replay.json` (see [cli.md](cli.md#orbitrace-export)) and open the file it writes.
- The privacy statement below, in one sentence.

After a replay opens, the app's own **Open file** button and drop area open the next one. Every
way a file gets in goes through the same checks.

## Privacy

The page says: "No server and no tracking: the file is read in your browser and is never
uploaded."

- The page loads only its own files (script, style sheet, icons, and the demo when picked) from
  the folder it is served from. It loads no remote font, script or analytics.
- An opened file is read with the browser's File API and stays in the page.
- The only request the page can make besides its own files is a `?replay=` link on the same
  origin (see below).
- It sets no cookie and uses no local storage, session storage or IndexedDB. It has no service
  worker.
- Links on the page, such as the export docs link, carry no referrer
  (`<meta name="referrer" content="no-referrer">`, `rel="noreferrer"`).

What a replay file contains, and what it never contains, is in [privacy.md](privacy.md) and
[replay-format.md](replay-format.md). A replay is structure only, but agent type names, model
ids and MCP server names are kept as they are: look at a file before you publish it.

### Content-Security-Policy

The built page carries this policy as a meta tag, before any script or style:

```text
default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

No inline script or style is allowed, and the page needs none. `frame-ancestors` cannot be set
from a meta tag; a host that wants to stop other sites framing the player sets it as a response
header.

## Limits and refusals

- **Size limit: 50 MB** (52,428,800 bytes), for an opened file and for a linked replay. A file
  over the limit is refused before any of it is read, and the message says the limit. A linked
  replay is refused when its `Content-Length` is over the limit, or as soon as the body passes
  it.
- **Schema.** A file that is not a valid replay (format version 1) is refused with the list of
  reasons from core's `describeReplayProblems`. The reasons name fields and rules, never a value
  from the file.
- **Untrusted input.** A replay, its file name and a link are untrusted. Every string from them
  reaches the page as text, never as HTML. The replay schema also allows only identifier
  characters in agent, model and tool names.
- A `.jsonl` Claude Code transcript can be opened too, as in the app: it is parsed in the page,
  and only the main agent is shown.

## Query parameters

| Parameter        | Meaning                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay=<path>`  | Open this replay when the page loads. A relative path (resolved against the page) or an absolute `http(s)` URL on the page's own origin. Any other origin, and `data:`, `blob:` or `javascript:` URLs, are refused with a message and never fetched. |
| `t=<seconds>`    | Start at this time on the replay's timeline.                                                                                                                                                                                                         |
| `select=<agent>` | Select this agent (`main`, `a1`, `a2`, ...).                                                                                                                                                                                                         |
| `speed=<rate>`   | Start at one of the playback speeds the app offers.                                                                                                                                                                                                  |
| `paused`         | Do not start playing.                                                                                                                                                                                                                                |

`t`, `select`, `speed` and `paused` apply to the first replay shown. For example, with
`shared.replay.json` in a `replays` folder next to the player:

```text
https://<host>/<folder>/?replay=replays/shared.replay.json&t=120&paused
```

Why other origins are refused: a public page that fetches any URL its link names could be used to
track visitors (every visit would call the named server) or to send requests to other sites. To
show a replay hosted elsewhere, download it and open it, or copy it next to the player.

## Build and host it

```sh
npm ci
npm run build                          # the workspace packages the player imports
npm run build:player -w @orbitrace/app # writes packages/app/dist-player
```

`packages/app/dist-player` is the whole site: `index.html`, `assets/`, `favicon.svg` and
`orbitrace-mark.svg`. Every URL in it is relative, so copy the folder to any path of any static
host. Put replay files next to it to link them with `?replay=`.

The page uses JavaScript modules, which browsers do not load from a file opened straight from
disk (`file://`). Serve the folder over http, even locally, for example:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory packages/app/dist-player
```

and open `http://127.0.0.1:8000/`.

The normal app build (`npm run build`, `packages/app/dist`), which the editor extension and the
command line ship, is not changed by the player build.

### GitHub Pages

`.github/workflows/pages.yml` builds the player and uploads it as a Pages artefact. It runs only
when started by hand (Actions, "Pages (player artefact)", Run workflow). It does not deploy and
does not enable Pages. To publish, the repository owner turns on Pages with GitHub Actions as the
source and adds a deploy job (`actions/deploy-pages`, which needs `pages: write` and
`id-token: write`).

## Tests

In `packages/app/test/player/`:

- `build.test.ts` builds the player and fails if the output loads anything by an absolute or
  root path, has inline script or style, lacks the policy, or names an absolute `http(s)` URL the
  page would load or fetch. Allowed are the XML namespace names and React's error-page prefix in
  React's code, and the export docs link, which a visitor clicks.
- `Player.test.tsx`: start state, demo, opening, refusals, the size limit, `?replay=`
  (same origin accepted, cross-origin refused and not fetched), and markup in file names, links
  and replay names.
- `open-file.test.ts`, `linked-replay.test.ts`, `replay-transport.test.ts`: the helpers.
- `a11y.test.tsx`: axe-core on the player's states.
