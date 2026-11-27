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
- A file you open in the public replay player ([player.md](player.md)). The player reads it in
  the page with the same loader as the app, and nothing is uploaded. Besides its own files, the
  only request it can make is for a `?replay=` link on its own origin; a link to another origin
  is refused and never fetched, and its Content-Security-Policy (`connect-src 'self'`) blocks
  requests to other origins. It has no export, sets no cookie, uses no browser storage and sends
  no telemetry.

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

## History store (#25)

**Built in core, not used by any command yet.** `@orbitrace/core/node` has a history store that
keeps a copy of your sessions so they outlive Claude Code's cleanup. No host (the CLI, the editor
extension, the app) calls it, so today nothing is recorded; the statement under
[What Orbitrace stores](#what-orbitrace-stores) still describes every command. Recording is
opt-in: nothing is written unless a program opens the store for writing and asks it to copy
sessions. How it works is in [architecture.md](architecture.md#history-store-25).

What it would store, once a host turns it on:

- Each line of each session's main transcript and subagent transcripts, as JSON text after
  redaction (below), and each subagent's meta file, also redacted. That is your content (prompts,
  replies, tool inputs and outputs, paths, branch names) minus what redaction replaced. Treat the
  store as being as sensitive as the transcripts themselves.
- Per session: the session key, the runtime's session id, the project label, the last activity
  time and when it was copied. Per transcript file: its device and inode numbers, how far it was
  read, and SHA-256 hashes of up to 4 KiB at its start and before that point, used to notice a
  replaced or truncated file.

Where and how:

- In `ORBITRACE_DATA_DIR` if set (an absolute path), otherwise in `.orbitrace` in your home folder:
  `history.sqlite`, SQLite's `history.sqlite-wal` and `history.sqlite-shm`, and `history.lock`
  while a writer runs.
- The folder is set to 0700 and the files to 0600 (your account only). On Windows, Node cannot set
  these and the folder's inherited permissions apply.
- It refuses a folder inside a git working tree (so it cannot end up in a commit) or inside a
  Claude Code config folder.
- Nothing is uploaded.

### Redaction (best effort)

Before a line is written it is parsed and every string in it, and every key, is checked against
these rules; a match is replaced with `[redacted:<rule>]`:

- Private key blocks (PEM): from a `BEGIN ... PRIVATE KEY` line to its `END` line, or to the end
  of the text when the end line is missing.
- API keys and tokens in well-known prefixed formats: Anthropic (`sk-ant-`), OpenAI-style (`sk-`,
  `sk-proj-`, `sk-svcacct-`, `sk-admin-`), GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`), GitLab (`glpat-`), AWS access key ids (`AKIA`, `ASIA`), Slack (`xoxa-`, `xoxb-`,
  `xoxp-`, `xoxo-`, `xoxr-`, `xoxs-`), Google API keys (`AIza`), Stripe (`sk_`, `rk_`, `pk_` with
  `live_` or `test_`), DigitalOcean (`dop_v1_`, `doo_v1_`, `dor_v1_`), npm (`npm_`), Hugging Face
  (`hf_`), and JSON Web Tokens (three dot-separated parts, the first two starting `eyJ`).
- The user name and password in a URL (`scheme://user:password@host`); the host is kept.
- `Authorization` and `Proxy-Authorization` header values (the scheme such as `Bearer` is kept),
  and `Bearer` or `Basic` followed by a value of 8 or more characters that contains a digit.
- `Cookie` and `Set-Cookie` header values, to the end of the line or the next quote.
- Assignments written as `name=value` or `name: value`, quoted or not, whose name **ends in** one
  of the secret words `password`, `passwd`, `secret`, `token`, `api_key`/`api-key`/`apikey`,
  `access_key`, `private_key`, `client_secret` or `credential(s)`, in any letter case, optionally
  followed by up to two short parts. A part starts with `_`, `.` or `-`, or is a camelCase part (an
  upper-case letter right after the word). Examples: `DB_PASSWORD=...`, `"api_key": "..."`,
  `DB_PASSWORD_PROD=...`, `SECRET_KEY_BASE=...`, `password_confirmation: ...`,
  `accessToken: ...`. A plain lower-case ending is not a part, so `max_tokens: 1000` and
  `tokenizer: ...` are left alone.
- Any string under a JSON key that ends in one of those words, `authorization` or `cookie`, after
  any characters and with the same optional parts, whatever it holds. This covers camelCase keys
  such as `"accessToken"`, `"refreshToken"`, `"githubToken"`, `"dbPassword"` and
  `"secretKeyBase"` as well as `"password"`, `"auth_token"` and `"SECRET_KEY_BASE"`.

A line that is not valid JSON is checked as text by the same rules. It is stored only when no rule
matches; otherwise it is skipped and counted, never stored.

What redaction does not catch:

- Secrets with no known prefix and no telling name: a random string pasted into a prompt, a
  password typed on its own, a key in a format not listed above.
- Secrets split across strings or lines, or encoded (base64 of a key file, URL-encoded values,
  escaped text inside a string that is itself JSON).
- Values passed as a separate command-line argument (`--password value`, `-p value`).
- Names where the secret word is not at the end and not followed by at most two short parts
  (`PASSWORD_FOR_THE_STAGING_DATABASE=...`), and names that do not use one of the words above
  (`pwd=...`, `pin=...`, `sid=...` outside a `Cookie` header).
- Header values other than `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie`
  (for example a custom `X-Session: ...` header), unless they match a token format.
- Personal data in general: names, email addresses, paths, file contents, project names. These
  are kept.

It can also replace harmless text that looks like a secret (for example a type annotation such as
`password: string`).

### Deleting

- One session: `deleteSession` removes its rows with SQLite's `secure_delete` on, so its pages are
  overwritten with zeros, then empties the WAL file, **but only when no reader has the store open
  inside a read**. SQLite cannot empty the WAL while a reader may still need it. In that case
  `deleteSession` reports `scrubbed: false`: the rows are gone, but old copies of their bytes stay
  in `history.sqlite-wal` until the readers close and `scrub()` succeeds (or the last connection
  closes). Tests check that a marker from the deleted session is gone from the raw bytes of the
  database files, and that an open reader makes `deleteSession` report the incomplete scrub.
- Everything: `deleteHistoryStore` deletes the database and the files SQLite keeps beside it,
  then the lock, then the folder if nothing else is in it. Files are unlinked, not overwritten; on
  SSDs and copy-on-write file systems an overwrite would not reach the old blocks anyway.
- Deleting history never touches Claude Code's transcripts.

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
  The opt-in [export options](#export-options-opt-in) replace those names and coarsen times and
  token counts; they are off by default.
- Export does not check the rules the schema cannot express (totals equal the sums, parents exist,
  ids in order, unique callsigns). The replay builder keeps them.

### Check before you share

Some allowed fields are names you chose. A custom agent type, an MCP server name or a callsign can
reveal a project or a client if you named it after one. Look at the agent and tool names in a
replay before you post it, or export with `--opaque-names` (next section).

### Export options (opt-in)

Three export options make a shared replay coarser (issues #122 and #123). They are off unless you
ask for them: with none of them, the file is the same, byte for byte, as before the options
existed (a test checks this against every golden replay). Each one keeps the file a valid replay
v1; the format does not change. On the command line they are `orbitrace export --opaque-names`,
`--round-times <seconds>` and `--bucket-tokens` (see [cli.md](cli.md#orbitrace-export)); in code
they are the `names: "opaque"`, `roundTimes` and `bucketTokens` fields of `ExportOptions`
(`exportReplay`, `packages/core/src/export/`).

**`--opaque-names`** (`names: "opaque"`) hides the names you chose:

- Each subagent's agent type becomes `agent-1`, `agent-2`, ...; its callsign keeps its `#n`
  (`code-reviewer#2` becomes `agent-1#2`). The main agent stays `main`.
- Each MCP server name becomes `mcp:server-1`, `mcp:server-2`, ...
- Each tool name that is not on a fixed list of built-in names becomes `tool_1`, `tool_2`, ...
  The list is `OPAQUE_KEPT_TOOL_NAMES` in `packages/core/src/export/opaque-names.ts`; a tool a
  newer Claude Code release adds shows as `tool_<n>` until it is added there.
- Each model id that is not a known Claude model id becomes `null`. Known means one of the
  family words `fable`, `opus`, `sonnet` or `haiku`, alone or as `claude-<family>-<version>` or
  `claude-<version>-<family>`, where the version is digits and dashes with an optional 8-digit
  date or `-latest` (`claude-opus-5-5`, `claude-3-5-sonnet-20241022`). The family is kept when
  it is one of those four, and becomes `unknown` otherwise, because a family word outside that
  list is part of the model id.

A label is a counter, in order of first appearance within one export (agents in id order, then
tools agent by agent). It is not a hash of the name, and no table from labels to names is
written, so a label cannot be turned back into the name. The same name can get a different label
in another file. What still shows: built-in tool names such as `Bash` or `Read`, known Claude
model ids, how many distinct names there are, which agents and calls share a name, and the order
in which they first appear.

**`--round-times <seconds>`** (`roundTimes`) hides exact times. Every time (agent, tool and reply
times, cut gaps, `duration` and `realDuration`) is rounded to the step, for example 0.1 s, from
0.001 s to 3600 s. A cut gap is never rounded below one step. The order of everything, rough
durations, and the real session length to the step still show.

**`--bucket-tokens`** (`bucketTokens`) hides exact token counts. Each reply's four token counts
become the nearest of 1, 2, 5, 10, 20, 50, ... (0 stays 0), at most a factor of about 1.6 from
the real count. Totals are the sums of those buckets. The rough size of each reply, prompt and
file read still shows.

None of the options hides the structure: how many agents there were, who started whom, the waves,
how many tool calls of each kind, which calls failed, and how many replies there were. Without
`--round-times` the times are exact, and without `--bucket-tokens` the token counts are exact.

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
