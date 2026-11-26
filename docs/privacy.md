# Privacy

**Status: nothing is released.** This page describes the design. Where something is not built yet, it says so.

The design rules are: session data stays on your machine, there is no telemetry unless you opt in, and a shared replay is built from an allow-list of fields instead of by redacting content.

Orbitrace is not affiliated with or endorsed by Anthropic. Claude Code is named here only to describe the tool whose files Orbitrace reads.

## What Orbitrace reads

### Claude Code transcripts (the default source)

Claude Code already writes these files. Orbitrace reads them and does not change them.

- Session transcript: `<config>/projects/<project>/<session-id>.jsonl`
- Subagent transcript: `<config>/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`, with an `agent-<agentId>.meta.json` file beside it.

`<config>` is the `.claude` folder in your home folder on macOS and Linux, and in your user profile folder on Windows. The `CLAUDE_CONFIG_DIR` environment variable moves it.

Each transcript line is a JSON object. Besides the structure Orbitrace needs (line type, timestamps, model, token counts, tool names, tool call ids, whether a call failed), a line can hold your prompts, the model's replies, tool inputs and outputs, the working directory, the git branch and the session title. The parser has to read whole lines to find the structural fields, so this content passes through memory on your machine. The replay model built from the parsed lines keeps structure only (see [What a shared replay contains](#what-a-shared-replay-contains)).

The transcript format is internal to Claude Code and changes between releases. There is no published schema. The parser (issue #6, not built yet) must skip line types it does not know and count them.

### Other sources

- Live session registry: `<config>/sessions/<pid>.json`. Seen on one machine, not documented by Anthropic. Treated as optional. Where Orbitrace uses it, it must check that the process is still running before treating a session as live.
- Session folders kept by the Claude Code desktop app. Opt-in only.
- Paths reported by Claude Code hooks. Hooks are optional and not built yet.
- A transcript file you drop onto the app.

### How Orbitrace picks a source

In this order: a path you set explicitly, `CLAUDE_CONFIG_DIR`, the default location for your operating system, known extra locations (opt in), and paths reported by hooks. Dropping a file onto the app always works.

### Retention by Claude Code

Claude Code deletes transcripts older than `cleanupPeriodDays`. The default is 30 days and the minimum is 1. It cannot be turned off. After Claude Code deletes a transcript, Orbitrace can replay that session only from its own record (next section).

## What Orbitrace will store

**Not built yet.** The first release has no database.

- A history record that outlives Claude Code's cleanup is planned. Its format, location and retention are not decided (see issues #24 and #25).
- Until that is decided, treat any stored copy of a session as being as sensitive as the transcript it came from.
- Whatever is stored stays on your machine. Nothing is uploaded unless you share a file yourself.

## What a shared replay contains

A shared replay file holds structure only. It is built from the allow-list below. Orbitrace does not copy the transcript and then remove sensitive parts.

**Not built yet.** The list below is the suggested shape. The final shape is fixed by the replay format work (issue #2) and the export work (issue #18). Any change to this list updates this page in the same pull request.

**Contains:**

- For each agent: an id, its name (the agent type, such as `code-reviewer`), a callsign (the name plus `#n` when the name repeats), the model (such as `claude-opus-5-5`), the model family, the effort level, the parent agent, its wave, and its start and end times.
- For each tool call: the tool name, the start and end times, and whether it failed. Built-in tool names such as `Bash` or `Read` are kept as they are. For an MCP tool only the server name is kept, as `mcp:<server>`.
- For each model reply: its time and its token counts (output, input, cache read and cache creation).
- Idle gaps cut from the timeline, with the time each one skipped.
- Totals for each agent and for the whole session.

**Never contains:**

- Message text: prompts, replies or thinking.
- Tool inputs or tool outputs.
- File paths.
- Command lines.
- The working directory.
- The git branch.
- The session title.
- The description of a subagent (from its `.meta.json` file).

The suggested shape has no session id field.

### Check before you share

Some allowed fields are names you chose. A custom agent type, an MCP server name or a callsign can reveal a project or a client if you named it after one. Look at the agent and tool names in a replay before you post it.

## Browser view

**Not built yet.** The planned browser view serves transcripts from your machine to your browser. It must listen on loopback only, on a random port, with a one-time token in the link, a Host header check and no cross-origin access. Without the token, any web page open in the same browser could read your transcripts from localhost. See [SECURITY.md](../SECURITY.md).

## Checks in this repository

`npm run privacy` fails when forbidden strings appear in the repository (issue #1). The CI pipeline will run it on every pull request (issue #3). **Neither is built yet.** Until then, use the privacy checklist in the pull request template.
