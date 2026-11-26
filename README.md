# Orbitrace

Replay and visualise Claude Code agent sessions.

Orbitrace reads the session transcripts that Claude Code already writes on your machine and plays them back as an orrery: the main agent in the centre, subagents in orbit, every tool call a flare. The name is orbit plus trace.

> **Status: not released.** From a clone of the `dev` branch you can build and run the web app with a bundled demo, the `orbitrace` command (`list`, `export` and `open`), and an editor extension that you package and install by hand. Nothing is on npm, the VS Code Marketplace or Open VSX yet. See [docs/getting-started.md](docs/getting-started.md).

## What it is for

- **Replay any session.** Watch what your agents did, scrub through it, skip the idle time, and click an agent to see its model, effort, tokens and tool calls.
- **Share a run without sharing your code.** A replay file holds structure only: agents, tool names, timing and token counts. No prompts, no file contents, no command output.
- **Keep the history.** Claude Code removes old transcripts on a timer. Orbitrace will keep its own record so a session can still be replayed later.
- **See your setup.** A map of your installed agents, skills, hooks and MCP servers, lit by what you actually use.

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
