# Orbitrace

Replay and visualise Claude Code agent sessions.

Orbitrace reads the session transcripts that Claude Code already writes on your machine and plays them back as an orrery: the main agent in the centre, subagents in orbit, every tool call a flare. The name is orbit plus trace.

> **Status: not released.** From a clone of the `dev` branch you can build and run the web app with a bundled demo, the `orbitrace` command (`list`, `export`, `open`, `history` and `doctor`), and an editor extension that you package and install by hand. Nothing is on npm, the VS Code Marketplace or Open VSX yet. See [docs/getting-started.md](docs/getting-started.md). What has changed so far is in [CHANGELOG.md](CHANGELOG.md), and how a release is cut is in [docs/releasing.md](docs/releasing.md).

## What works on `dev`

- **Follow live.** A running session opens at its newest moment and keeps up as it grows ([below](#follow-a-running-session)).
- **Public replay player.** A static page that opens a shared replay file in the browser; you build it yourself ([below](#public-replay-player)).
- **Export with privacy options.** `orbitrace export` and the app's Export button write a structure-only replay file. Opaque names, rounded times and bucketed tokens are opt-in and off by default. See [docs/privacy.md](docs/privacy.md#export-options-opt-in).
- **Cost estimate.** The inspector shows a session's tokens in four classes and an estimated cost at list prices, by model and by agent. Cache writes have two prices, for the 5-minute and the 1-hour cache. The ledger prices each part at its own price when the model records which cache each write used. No host passes that record to the app on `dev` yet, so the inspector prices every cache write at the 5-minute price and says so in a note. See [docs/ledger.md](docs/ledger.md).
- **`orbitrace doctor`.** Checks the set-up, says what is wrong and how to fix it, and changes nothing. See [docs/cli.md](docs/cli.md#orbitrace-doctor).
- **`orbitrace history`, off by default.** Keeps a copy of your sessions in a local SQLite file, so a session can still be replayed after Claude Code deletes its transcript. `enable` turns recording on: from then on `orbitrace open` copies sessions in a background thread while it runs. `ingest` copies every session found once, now, whether recording is on or not. `list` shows the stored sessions and whether each transcript is still found. `delete <key>` removes one stored session and `delete --all` removes the whole store. Sessions that only the store holds also show in `orbitrace list` and can be exported and opened. The store keeps your content (prompts, replies, tool inputs and outputs) with known secret formats redacted, and needs Node 22.13 or later. See [docs/cli.md](docs/cli.md#orbitrace-history) and [docs/privacy.md](docs/privacy.md#history-store-25).
- **No history in the editor yet.** The editor extension has no history switch on `dev` and records nothing.

## What it is for

- **Replay any session.** Watch what your agents did, scrub through it, skip the idle time, and click an agent to see its model, effort, tokens and tool calls.
- **Share a run without sharing your code.** A replay file holds structure only: agents, tool names, timing and token counts. No prompts, no file contents, no command output.
- **Keep the history.** Claude Code removes old transcripts on a timer. Orbitrace can keep its own record, when you turn it on, so a session can still be replayed later. On `dev` only the command line does this.
- **See your setup.** A map of your installed agents, skills, hooks and MCP servers, lit by what you actually use.

## Follow a running session

Open a session that is still running, with `orbitrace open` or in the editor, and the view starts at the live edge, the newest moment, and keeps up as the session grows. Scrubbing back with the arrow keys, Home or Pause stops following; the **Go live** button or the End key returns to it. The Live badge says `Live: working, following`, or how far behind the view is, for example `Live: idle, 2 min 5 s behind`. Whether a session is running comes from Claude Code's session registry; `orbitrace list` shows it in the LIVE column. Details are in [packages/app/README.md](packages/app/README.md).

## Public replay player

The public replay player is a static page that opens a shared replay file in the browser, with no server part and no tracking: the file is read in the page and never uploaded. You build it from a clone; it is not hosted anywhere yet. See [docs/player.md](docs/player.md).

## How it will ship

- An editor extension for VS Code and compatible editors: click the icon, press Visualise.
- A command-line entry for people outside an editor.
- A Claude Code plugin with an optional setup skill and a doctor command, so an agent can install and troubleshoot it.

Reading transcripts needs no hooks and no configuration. Hooks are an optional extra.

## Principles

- **Local first.** Session data stays on your machine. No telemetry unless you opt in.
- **Safe by construction.** Shared replays are built from an allow-list of fields, not by redacting content.
- **Tolerant.** The transcript format is internal to Claude Code and changes between versions. The parser skips what it doesn't recognise and says so.

## Scope

Claude Code only for now. The design keeps other agent runtimes possible later.

## Licence

MIT. See [LICENSE](LICENSE).

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's names for its products and are used here only to say which tool Orbitrace works with. See [docs/legal/trademarks.md](docs/legal/trademarks.md).
