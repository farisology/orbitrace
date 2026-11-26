# Privacy

Orbitrace is local first. Session data stays on your machine. There is no telemetry unless you opt in.

**Status: nothing is released.** This page describes the design. Where something is not built yet, it says so.

Orbitrace is not affiliated with or endorsed by Anthropic. "Claude Code" is named here only to describe the tool whose files Orbitrace reads.

## What Orbitrace reads

### Claude Code transcripts (the default source)

Claude Code writes one transcript per session:

- `<config>/projects/<project>/<session-id>.jsonl`
- Subagent transcripts: `<config>/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`, with an `agent-<agentId>.meta.json` file beside each one.

The config folder is, by default, a `.claude` folder in the user's home directory. On Windows it is under the user's profile folder. The `CLAUDE_CONFIG_DIR` setting moves it.

Transcript lines also carry fields such as the working directory, the git branch and the session title. Shared replays never include them (see below).

### Other locations

- Live session registry (observed, not documented by Anthropic): `<config>/sessions/<pid>.json`. Orbitrace would check that the process is still running. This may be dropped.
- Session folders kept by the Claude Code desktop app. These are an opt-in source.
- Paths that hooks report. Hooks are optional and are not built yet.

### How Orbitrace picks a source

In this order: an explicit setting from the user, `CLAUDE_CONFIG_DIR`, the default location for the operating system, known extra locations (opt in only), and paths reported by hooks. Dropping a transcript file onto the app always works.

### Retention by Claude Code

Claude Code removes old transcripts after `cleanupPeriodDays`, which defaults to 30 days. The minimum is 1 day. It cannot be turned off. A replay of a session is only possible after the transcript is removed if Orbitrace has kept its own copy (see the next section).

## What Orbitrace will store

**Not built yet.** The first release has no database.

- Orbitrace plans to keep its own record of sessions, so a session can be replayed after Claude Code removes its transcript.
- The format, location and retention period of that record are not decided yet.
- Until they are decided, treat any stored copy of a session as sensitive. It can contain prompts and file contents, the same as the transcript it came from.

## What a shared replay contains

A shared replay file holds structure only. It is built from an allow-list of fields. Orbitrace does not start from the full transcript and remove the sensitive parts.

The field list below is the suggested shape. The final shape is set by the replay contract work and may change. Any change to the list updates this page in the same change.

**Contains:**

- For each agent: its name (the agent type, such as `code-reviewer`), a callsign (the name, with `#n` when the name repeats), the model name, the model family, the effort level, the parent agent, the wave it belongs to, and its start and end times.
- For each tool call: the tool name, start and end times, and whether it failed. Built-in tool names such as `Bash` or `Read` are kept. MCP tools keep only the server name, as `mcp:<server>`.
- For each model reply: the time and the token counts (output, cache read and the other token classes).
- Idle gaps that were cut from the timeline, with the time each one skipped.
- Totals for each agent and for the whole session.

**Never contains:**

- Message text, including the text of prompts and replies.
- Tool inputs and tool outputs.
- File paths.
- Command lines.
- The working directory.
- The git branch.
- The session title.
- The description of a subagent.

The suggested shape has no session id field. If a session id field is ever added, this page changes in the same pull request.

## Checks

The `npm run privacy` command is meant to check the privacy rules. **It is not built yet.** Until it exists, check the rules by hand with the checklist in the pull request template.

## Your own copies

A replay file or a stored record stays on your machine unless you share it. Review a shared replay yourself before you post it anywhere.
