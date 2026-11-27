# Privacy

**Status: nothing is released.** This page describes what the code on `dev` does. Where something
is not built yet, it says so.

The design rules are: session data stays on your machine, there is no telemetry, and a shared
replay is built from an allow-list of fields instead of by redacting content.

Orbitrace is not affiliated with or endorsed by Anthropic. Claude Code is named here only to
describe the tool whose files Orbitrace reads.

## What Orbitrace reads

### Claude Code transcripts (the default source)

Claude Code already writes these files. Orbitrace reads them and does not change them.

- Session transcript: `<config>/projects/<project>/<session-id>.jsonl`
- Subagent transcript: `<config>/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`,
  with an `agent-<agentId>.meta.json` file beside it.

`<config>` is the `.claude` folder in your home folder on macOS and Linux, and in your user
profile folder on Windows. The `CLAUDE_CONFIG_DIR` environment variable moves it.

Each transcript line is a JSON object. Besides the structure Orbitrace needs, a line can hold
your prompts, the model's replies, tool inputs and outputs, the working directory, the git branch
and the session title. Each line is parsed as a whole, so this content passes through memory on
your machine; the parser does not keep the raw text of a line.

### What the parser keeps

The parser (`parseSession`, issue #6) reads each transcript line by line.

- It skips blank lines without counting them. It skips lines whose type it does not know and
  counts them by type, and it counts lines that are not a JSON object as malformed. The
  transcript format is internal to Claude Code and changes between releases; there is no
  published schema.
- It reads only structure: the line type, timestamps, the session id and message, line and tool
  use ids, the Claude Code version, the model, the effort level, the token counts of each reply,
  tool names, and whether a tool result was an error.
- From a subagent's `.meta.json` file it reads the agent type, the model, the spawn depth,
  whether the agent is built in, whether it finished, and the id of the tool call that started
  it.
- It never reads message text, thinking, tool inputs or outputs, the working directory (`cwd`),
  the git branch (`gitBranch`) or the subagent description.

The session id and the other runtime ids stay on your machine: they link the parts of a session
together and are not part of a replay.

### Session lists

To list sessions, the Claude Code adapter (issue #7) reads folder listings and file times under
`<config>/projects/`. To give each session a project name, it reads the working directory from
the live registry entry when there is one, and otherwise from the first 64 KB of a transcript of
that project folder. Only the `cwd` value is used, and only its last folder name is shown. The
session key it gives each session is a hash, so it holds no path or project name.

The project name is shown to you in session lists (`orbitrace list`, the extension's Sessions
view, the app's session picker). The session id is not shown there, but it is part of the session
summary a host sends to the app and of the `orbitrace list --json` output. Neither is ever put in
a replay.

### Other sources

- Live session registry: `<config>/sessions/<pid>.json`. Seen on one machine, not documented by
  Anthropic. Treated as optional. The adapter checks that the process is still running before it
  shows a session as live.
- Session folders kept by the Claude Code desktop app. Opt in only (`orbitrace --extra-roots`;
  the extension does not read them). The adapter scans
  `<app data>/Claude/local-agent-mode-sessions`, where `<app data>` is
  `~/Library/Application Support` on macOS, `%APPDATA%` on Windows, and `$XDG_CONFIG_HOME` (or
  `~/.config`) elsewhere.
- Paths reported by Claude Code hooks. Core can resolve a config folder from one, but no host
  passes any yet.
- A file you drop onto the app, or open with its Open file button. It is read inside the page and
  is not sent anywhere: a `.replay.json` is checked with `validateReplay`, and a `.jsonl`
  transcript is parsed with `parseSession` and built with `buildReplay`.

### How Orbitrace picks a source

In this order: a folder you set explicitly (`orbitrace --config-dir`), `CLAUDE_CONFIG_DIR`, the
default location for your operating system, the desktop app's folders (opt in), and paths
reported by hooks. A dropped file does not go through this at all.

### Retention by Claude Code

Claude Code deletes transcripts older than `cleanupPeriodDays`. The default is 30 days and the
minimum is 1. It cannot be turned off. After Claude Code deletes a transcript, Orbitrace cannot
replay that session, because it keeps no record of its own (next section).

## What Orbitrace stores

**Nothing yet.** There is no database and no history record.

- A history record that outlives Claude Code's cleanup is planned. Its format, location and
  retention are not decided (see issues #24 and #25). Until that is decided, treat any stored copy
  of a session as being as sensitive as the transcript it came from.
- The files Orbitrace writes today: a replay file, only when you run `orbitrace export` with
  `-o`; and, while `orbitrace open` runs, a launcher page (`open.html`, readable by your account
  only) in a new private folder under the system's temporary folder, deleted when the command
  stops. See [architecture.md](architecture.md#opening-the-browser).
- Nothing is uploaded. Orbitrace has no telemetry.

## What a shared replay contains

A shared replay file holds structure only. It is built from the allow-list below. Orbitrace does
not copy the transcript and then remove sensitive parts. The format is described in
[replay-format.md](replay-format.md). Any change to this list updates this page in the same pull
request.

**Contains:**

- For each agent: an id assigned by the builder (`main`, `a1`, `a2`, ...), its name (the agent
  type, such as `code-reviewer`), a callsign (the name plus `#n` when the name repeats), the model
  (such as `claude-opus-5-5`), the model family, the effort level, the parent agent, its wave,
  and its start and end times.
- For each tool call: the tool name, the start and end times, and whether it failed. Built-in tool
  names such as `Bash` or `Read` are kept as they are. For an MCP tool only the server name is
  kept, as `mcp:<server>`.
- For each model reply: its time and its token counts (input, output, cache read and cache
  creation).
- Idle gaps cut from the timeline, with the time each one skipped.
- Totals for each agent and for the whole session.

Times are seconds from the session start, not wall-clock times.

A name that is not already an identifier (spaces, slashes, `@`, line breaks, non-ASCII, more
than 64 characters) is replaced whole by a fixed label: `subagent` for an agent type, `unknown`
for a tool name, `mcp:unknown` for an MCP server. No part of it is kept. The rules are in
`packages/core/src/replay/names.ts`; why a name is replaced and not shortened is finding F1 of
the [export audit](security/export-audit.md).

**Never contains:**

- Message text: prompts, replies or thinking.
- Tool inputs or tool outputs.
- File paths.
- Command lines.
- The working directory.
- The git branch.
- The session title.
- The session id, or any id from the runtime (agent id, tool use id, line id).
- The description of a subagent (from its `.meta.json` file).
- The project name.

### What export guarantees

A replay file is written by `exportReplay` (issue #18, `packages/core/src/export/export-replay.ts`).
`orbitrace export` uses it. The whole path from a transcript line to a shared file, field by
field, was audited in [security/export-audit.md](security/export-audit.md) (#23), with its
findings and the tests that guard them. For every file it writes:

- The data is built from an allow-list of the replay fields. Any other property of the input, at
  any depth, is dropped, never copied.
- The value is checked against the replay v1 schema before it is written. The schema limits every
  string to an identifier pattern with no spaces, slashes, backslashes or line breaks, so message
  text, file paths and command lines cannot be stored in any string field.
- The same input gives the same bytes: keys are written in a fixed order.
- The suggested file name is always `orbitrace.replay.json`. It holds no session id or project
  name.

Not guaranteed:

- The allowed values are still real: agent type names, callsigns, model ids, tool names
  (`mcp:<server>` keeps the MCP server name), times and token counts. A name you chose is exported
  as it is, so a custom agent type or MCP server named after a project or client is in the file,
  and a secret shaped like an identifier placed in a name field would pass the pattern check.
- Export does not check the rules the schema cannot express (totals equal the sums, parents exist,
  ids in order, unique callsigns). The replay builder keeps them.

### Check before you share

Some allowed fields are names you chose. A custom agent type, an MCP server name or a callsign can
reveal a project or a client if you named it after one. Look at the agent and tool names in a
replay before you post it.

## Editor tab and browser view

Both show the same app. They get session summaries (session key, project name, session id, last
activity, live status, subagent count) and structure-only replays from the host. They never get
transcript lines, file paths or locators.

- **Editor tab** (the extension): the page's Content-Security-Policy blocks every network request
  (`connect-src 'none'`) and allows scripts, styles and images only from the extension's own files.
  The Sessions view does not show session ids.
- **Browser view** (`orbitrace open`): a server that listens on `127.0.0.1` only, on a port the
  system picks, with a token that is new on every start, a Host header check and no cross-origin
  access. Anyone who has the link can read your sessions while the server runs, so do not share
  it. The design and what it does not protect against are in
  [architecture.md](architecture.md#loopback-server-and-routes-17); see also
  [SECURITY.md](../SECURITY.md).

## Checks in this repository

`npm run privacy` fails when known forbidden strings appear in the repository files (home-folder
paths, email addresses, some token formats, private key blocks, and patterns from an optional
local denylist). `npm run privacy -- --range <base>..<head>` checks what a range of commits adds,
including commit messages. CI runs both on every pull request. Passing the check does not prove a
change is clean; also use the privacy checklist in the pull request template.
