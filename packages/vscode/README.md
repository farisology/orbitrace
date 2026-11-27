# Orbitrace: Agent Session Visualizer

Orbitrace replays Claude Code agent sessions as an orrery in an editor tab: the main agent in the centre, subagents in orbit, each tool call a flare. It reads the transcripts that Claude Code already writes, follows a running session live, and uploads nothing.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: preview, not released.** The extension is not on the VS Code Marketplace or Open VSX yet. To try it, build and install it from source ([Build from source](#build-from-source)).

## Open a session

1. Click the Orbitrace icon in the activity bar. The **Sessions** view lists the Claude Code sessions on this machine: the sessions of the open workspace folder first, then the rest, newest first.
2. Press **Visualise** (the play button in the view title), or click a session.

With no sessions on the machine, the view offers **Open demo**: a replay made from invented data.

Commands (Command Palette):

| Command                              | What it does                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Orbitrace: Visualise current session | Opens the newest session of the open workspace folder. With none, the newest session on the machine. With no sessions at all, the demo. |
| Orbitrace: Visualise session...      | Lets you choose a session.                                                                                                              |
| Orbitrace: Open demo                 | Opens the bundled demo replay, made from invented data.                                                                                 |
| Orbitrace: Refresh sessions          | Lists the sessions again.                                                                                                               |

Each session opens in its own tab. Running the command again for the same session brings its tab to the front.

A session belongs to the workspace only when Claude Code was started in the workspace folder itself. A session started in a subfolder counts as another project. When there are sessions of both kinds, the view groups them under "This workspace" and "Other projects".

## Follow a running session

The extension sends live updates to a tab while it is open. A running session opens at the live edge, the newest moment, and the tab keeps up as the session grows. Scrubbing back, Home or Pause stops following. **Go live** or the End key returns to the edge.

## What it reads

- The Claude Code config folders: the one named by `CLAUDE_CONFIG_DIR` when the extension host has it set, and `.claude` in the home folder. Both are read when both exist. Inside each, the session transcripts under `projects/`, and the entries under `sessions/` that say which sessions are running.
- Files are only read, never written. The extension stores nothing of its own.
- It has no setting, needs no hooks and needs no account.

## Nothing leaves the machine

- Transcripts are read on the machine they are on. Nothing is uploaded, and there is no telemetry.
- The editor tab gets session summaries (project name, session id, last activity, live status, subagent count) and structure-only replays. It never gets transcript text, file paths or command lines.
- The tab's Content-Security-Policy allows scripts, styles and images only from the extension's own files and blocks every network request (`connect-src 'none'`).
- The Sessions view does not show session ids.

What a replay contains is described in [Privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md) and [Replay format](https://github.com/farisology/orbitrace/blob/main/docs/replay-format.md).

## Remote machines

The extension runs where the workspace is (`extensionKind: workspace`). Over Remote SSH, in a dev container or in WSL it reads the Claude Code folders of the remote machine, which is where those sessions are written. VS Code's own remote connection then carries the summaries and replays to the tab.

## Requirements

- VS Code 1.96 or later.
- Claude Code sessions on the machine where the workspace is. Without any, the demo still opens.
- Works in Restricted Mode (untrusted workspaces). Not available in virtual workspaces, because it reads files from the file system.

## Learn more

- [Getting started](https://github.com/farisology/orbitrace/blob/main/docs/getting-started.md): build and try every part of Orbitrace.
- [Privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md): what Orbitrace reads, stores and puts in a shared replay.
- [Architecture](https://github.com/farisology/orbitrace/blob/main/docs/architecture.md): the packages and how data flows between them.
- [Trademarks and names](https://github.com/farisology/orbitrace/blob/main/docs/legal/trademarks.md): how this project refers to Claude Code.
- [Changelog](https://github.com/farisology/orbitrace/blob/main/CHANGELOG.md) and [issues](https://github.com/farisology/orbitrace/issues).

## Build from source

From the repository root, with Node.js 22 or later (the pinned `@vscode/vsce` needs it):

```sh
npm ci
npm run build
(cd scripts/release/tools && npm ci --ignore-scripts)
out="$(mktemp -d)/artefacts"
node scripts/release/pack-release.mjs --out "$out"
code --install-extension "$out"/orbitrace-vscode-0.0.0.vsix
```

`npm run build` bundles the extension and `@orbitrace/core` into one file (`dist/extension.js`) with esbuild and copies the built web app into `dist/app`. `pack-release.mjs` packages the `.vsix` with the copy of `@vscode/vsce` pinned in `scripts/release/tools/`, and also packs and checks the npm tarballs. `--out` must be an empty folder outside the repository. The `.vsix` holds only the bundle, the app, the activity-bar icon, the listing icon, this readme and the licence. The repository's `docs/releasing.md` describes the packaging in full.

## Integration test

`npm test` runs unit tests with a fake `vscode` module. The integration test runs the built extension in a real VS Code window instead. It is not part of `npm test`, because it downloads VS Code and needs a display. CI runs it in a separate job (see below).

From the repository root, with Node.js 22 or later:

```sh
npm run build
npm run test:integration -w orbitrace-vscode
```

What a run does:

1. Writes a throwaway folder in the system temporary folder: a Claude Code config folder generated by `@orbitrace/fixtures` (invented sessions only, one of them filed under the test workspace), an empty home folder, a workspace folder, and the editor's own user-data and extensions folders.
2. Downloads VS Code with `@vscode/test-electron` the first time, into `packages/vscode/node_modules/.cache/vscode-test/`. Later runs reuse it; `npm ci` deletes it.
3. Starts that VS Code with this package as the extension under development, `CLAUDE_CONFIG_DIR` and `HOME` pointing into the throwaway folder, secrets kept in memory instead of the OS keychain, and telemetry, crash reports and update checks off. When you run it from a terminal inside VS Code, that window's `VSCODE_*` and `ELECTRON_*` variables are not passed on. Your own `~/.claude`, VS Code profile, extensions and keychain are not read or changed.
4. Runs the suite in `test-integration/suite.ts`, prints one line per step, closes the window, kills any editor process that is left, and deletes the throwaway folder. A run takes a few seconds once VS Code is downloaded.

What it checks: the extension activates when the Sessions view opens; its commands are registered; the Sessions view lists the synthetic sessions with the workspace's own first; Visualise current session opens a tab whose page has the Content-Security-Policy, both host meta tags and resource URLs that resolve to files in `dist/app`; the app inside the tab starts under that policy and sends its own `listSessions` and `subscribe` requests, which the extension answers; `listSessions`, `loadReplay` and `subscribe` sent to the tab's message handler get correct replies and live updates; nothing sent to the tab holds a path; closing the tab stops its subscriptions and file watchers; with no sessions, Open demo and Visualise current session show the demo tab.

What it does not check: what the tab draws. The extension cannot read a webview's page or pixels. The app sending its first request is the evidence that its bundle loads and runs inside the editor. The demo tab sends no messages, so nothing shows that its bundle runs.

Settings (environment variables, all optional):

| Variable                      | Effect                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `ORBITRACE_VSCODE_VERSION`    | VS Code version: `stable` (default), `insiders`, or a number such as `1.96.0`.             |
| `ORBITRACE_IT_TIMEOUT_MS`     | Timeout of the whole run after the download, in milliseconds. Default 180000.              |
| `ORBITRACE_IT_KEEP_SANDBOX=1` | Keep the throwaway folder after a failed run. The editor's logs are under `ud/logs` there. |
| `ORBITRACE_IT_EDITOR_ARGS`    | Extra editor arguments, separated by spaces, for debugging.                                |

On Linux without a desktop, run it under a virtual display, for example `xvfb-run -a npm run test:integration -w orbitrace-vscode`.

In CI the job "VS Code integration test (Node 22)" in the repository's `.github/workflows/ci.yml` runs it on every pull request into `dev` or `main` and every push to `dev`. It looks up the current stable VS Code version, passes it as `ORBITRACE_VSCODE_VERSION`, caches `packages/vscode/node_modules/.cache/vscode-test` under that version, runs `npm run build`, and then runs the test under `xvfb-run -a`. A failure fails the workflow.

## Listing metadata

Notes for maintainers. Nothing is published yet, and the publisher is not set.

The VS Code Marketplace and Open VSX both build the listing from the same `.vsix`: the listing fields in `package.json` (`displayName`, `description`, `categories`, `keywords`, `icon`, `galleryBanner`, `pricing`, `preview`, `qna`, `repository`, `bugs`, `homepage`, `license`) and this readme.

- The display name uses the spelling "Visualizer", and the description carries the independence statement, as `docs/legal/trademarks.md` asks for every listing.
- `categories` uses only a value from the list in the VS Code extension manifest reference. `keywords` may hold at most 30 entries.
- The icon, `media/icon.png`, is `design/icons/favicon.svg` drawn at 256x256 by headless Chrome. The listing needs a PNG of at least 128x128; vsce refuses an SVG icon. To draw it again, run `node packages/vscode/scripts/build-icon.mjs` from the repository root (set `CHROME_PATH` if Chrome is not in the default place), then `node packages/vscode/scripts/build-icon.mjs --check`.
- The banner colour is `void` from `design/tokens.json`, with the `dark` theme for light text.
- vsce rewrites relative links in this readme against the repository root, not this folder, so links to the docs here are full URLs. Images in a readme must be `https` URLs and not SVG files.
- No screenshots yet: images the readme loads by URL must stay out of the `.vsix`, and `files` in `package.json` ships every file in `media/`.

What Open VSX needs that the Marketplace does not:

- A licence. `ovsx publish` refuses an extension that has neither a `license` field nor a licence file. This one has both (MIT).
- A namespace on open-vsx.org with the same id as the Marketplace publisher, created by an account that has accepted the Eclipse Foundation publisher agreement. These are owner steps, described in `docs/releasing.md`.

Not checked: which of the Marketplace-only fields (`qna`, `pricing`, `galleryBanner`, `preview`) the Open VSX page shows.

## Licence

MIT. See [LICENSE](LICENSE).
