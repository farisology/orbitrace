# Command line

`orbitrace` lists the Claude Code sessions on your machine, opens one in your browser through a
local server, exports a structure-only replay of one of them, keeps an opt-in history of your
sessions with `orbitrace history`, and checks the set-up with `orbitrace doctor`. Orbitrace is
not affiliated with Anthropic.

**Status: not released.** The package is private and not on npm, so `npx orbitrace` does not work
yet (see [Install](#install)).

## Install

Not published. From a clone of the repository:

```sh
npm ci
npm run build
node packages/cli/dist/index.js --help
```

[getting-started.md](getting-started.md#run-the-orbitrace-command) shows how to try the commands
on the repository's synthetic sessions without reading your own.

## Commands

| Command                      | What it does                                               |
| ---------------------------- | ---------------------------------------------------------- |
| `orbitrace`                  | The same as `orbitrace open`.                              |
| `orbitrace open [<key>]`     | Opens a session in your browser; runs until Ctrl+C.        |
| `orbitrace list`             | Lists sessions, newest first.                              |
| `orbitrace export <key>`     | Writes the replay of one session.                          |
| `orbitrace export --latest`  | Writes the replay of the session with the newest activity. |
| `orbitrace history <cmd>`    | Turns history on or off, copies, lists and deletes it.     |
| `orbitrace doctor`           | Says what is wrong with the set-up and how to fix it.      |
| `orbitrace help [<command>]` | Shows help. `orbitrace <command> --help` shows the same.   |
| `orbitrace --version`        | Prints the version and the status of `@orbitrace/core`.    |

`orbitrace` with no command runs `open` with its defaults: the newest session opens in your
default browser. `orbitrace --help` prints the help.

### `orbitrace open`

```text
orbitrace open [<session-key> | --latest] [--no-browser] [--port <n>]
               [--config-dir <path>]... [--extra-roots] [--json]
```

Starts a local server on `127.0.0.1` (this computer only), prints a link to the web app, opens
the link in your default browser and keeps running until you press Ctrl+C. Ctrl+C closes every
live stream and stops the server; the command then exits with 0. A second Ctrl+C exits at once.

The link looks like `http://127.0.0.1:<port>/#t=<token>&key=<session key>`. The token is new
every time the command starts. **Anyone who has the link can read your sessions while the server
runs, so do not share it or paste it anywhere.** It is in the part after `#`, which the browser
never sends to a server. The security design and what it does not protect against are in
[architecture.md](architecture.md#loopback-server-and-routes-17).

| Option                          | Meaning                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<session-key>`                 | A key from `orbitrace list`, or a unique start of one, as for `export`.                                                                   |
| `--latest`                      | The session with the newest activity. Fails with `no-sessions` when there is none.                                                        |
| (neither)                       | The newest session when there is one; otherwise the link opens the session list (the app shows its built-in demo when the list is empty). |
| `--no-browser`                  | Print the link only. Use it on a machine without a desktop, or to open the link in another browser.                                       |
| `--port <n>`                    | Listen on this port (1 to 65535). Without it the system picks a free port. A port in use fails with `port-unavailable`.                   |
| `--config-dir`, `--extra-roots` | As for `list`. The server looks for sessions again each time the app asks for the list, so a session started later shows up.              |
| `--json`                        | See [JSON output](#json-output).                                                                                                          |

Without `--json`, the link is the only line written to stdout, so a script can read it. The
other lines (where the server listens, whether the browser opened, how to stop) go to stderr.
The token is never written to stderr and never passed as a program argument.

The link is never put on a command line, because other accounts on the machine can read the
arguments of every process. The command writes a small launcher page instead (`open.html`,
readable by your account only, in a new private folder under the system's temporary folder) that
redirects to the link, and opens that page without a shell: `open <page>` on macOS,
`xdg-open <page>` on Linux and other systems, and `cmd.exe /d /v:off /s /c "start "" "<page>""` on
Windows. Only the page's path, which holds no token, appears in the process list. The page is
deleted when the command stops. If the opener cannot start, the command says so and keeps
running: open the link yourself.

If you pass the link to a browser on its command line yourself, other accounts on the machine can
see it in the process list. On a shared machine, use `--no-browser` and paste the link into a
browser that is already running. Use `--no-browser` too when `.html` files open in an editor on
your system, or when your browser is a Snap or Flatpak that cannot read the temporary folder.

Asking the server to open a session in the browser (the app's `openInBrowser` request) answers
with the `unsupported` error: the browser view is already in the browser.

When history recording is on (`orbitrace history enable`), `open` also copies sessions into the
history store while it runs: all of them once at the start, and a session the app shows again
about 2 seconds after it changes. The copy runs in a worker thread, so the server never waits for
it, and it stops when the server stops (a copy in progress is cut off; what it committed stays).
It reads the settings file again before each copy, so `orbitrace history disable` also stops a
running `open` before its next copy (it says so once on stderr); turning recording on again takes
effect the next time `open` starts. Nothing keeps running after `open` ends. If this run cannot record (this Node has no
`node:sqlite`, or the build has no history worker), the command says so in a
`history-not-recorded` warning and serves as usual. Sessions only the history store holds are
listed and served too (see [`orbitrace history`](#orbitrace-history)).

### `orbitrace list`

```text
orbitrace list [--config-dir <path>]... [--extra-roots] [--limit <n>] [--json]
```

Prints one row per session: the session key, the time of the last activity (local time), the live
status, the number of subagents and the project name (the last folder name of the session's working
folder). The session key is what `export` takes. It is a hash: it holds no path or project name.

| Option                | Meaning                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config-dir <path>` | A Claude Code config folder (the one that holds `projects/`). Searched first. Repeatable. A relative path is taken from the current folder. |
| `--extra-roots`       | Also search the desktop app's own session folders. Off by default.                                                                          |
| `--limit <n>`         | Show at most `n` sessions.                                                                                                                  |
| `--json`              | See [JSON output](#json-output).                                                                                                            |

A `--config-dir` folder that is missing or cannot be read gives a warning, not an error. Finding no
sessions is not an error either: the command prints "No sessions found." and exits with 0.

Sessions that only the history store holds (their transcripts were not found in the folders
searched, for example after Claude Code's cleanup) are listed too. The table then has a `SOURCE`
column, `history` for them and `files` for the others, and their live status is `ended`. A session
whose transcript is still found is always read from its files. When a store exists but this Node
cannot read it, the command lists the files only and gives a `history-unavailable` warning.

### `orbitrace export`

```text
orbitrace export (<session-key> | --latest) [-o <file>] [--force] [--pretty]
                 [--opaque-names] [--round-times <seconds>] [--bucket-tokens]
                 [--config-dir <path>]... [--extra-roots] [--json]
```

Builds the replay of one session with core's session replayer and writes it with core's
`exportReplay`: the structure-only replay format described in
[replay-format.md](replay-format.md). No message text, tool input or output, file path, command
line, working folder or session id is in it. Agent type names, model ids and MCP server names
are kept as they are, so look at them before you share a file, or add `--opaque-names`.

| Option                          | Meaning                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<session-key>`                 | A key from `orbitrace list`, or a unique start of one: at least 4 characters of the part after `claude-code:`, with or without that part. |
| `--latest`                      | The session with the newest activity. Give either a key or `--latest`.                                                                    |
| `-o, --output <file>`           | Write to this file. A folder gets `orbitrace.replay.json` inside it. `-` means stdout. Without `-o`, the replay goes to stdout.           |
| `--force`                       | Replace the output file if it exists. Without it, an existing file is never replaced.                                                     |
| `--pretty`                      | Indent the JSON.                                                                                                                          |
| `--opaque-names`                | Replace the names you chose with numbered labels (below). Off by default.                                                                 |
| `--round-times <seconds>`       | Round every time to this step, for example `0.1`: from `0.001` to `3600`, in whole milliseconds. Off by default.                          |
| `--bucket-tokens`               | Write token counts as buckets (below). Off by default.                                                                                    |
| `--config-dir`, `--extra-roots` | As for `list`. Use the same values as for the `list` that gave you the key: the key depends on the folder the session was found in.       |
| `--json`                        | See [JSON output](#json-output).                                                                                                          |

The last three are opt-in (#122, #123). Without them the file is the same, byte for byte, as
before they existed. Each keeps the file a valid replay v1. What each one hides, and what it
does not:

- `--opaque-names` writes every subagent's agent type as `agent-1`, `agent-2`, ... (the callsign
  keeps its `#n`), every MCP server as `mcp:server-1`, ..., every tool name that is not built in
  as `tool_1`, ..., and every model id that is not a known Claude model id as `null` (the family
  is kept only when it is `fable`, `opus`, `sonnet` or `haiku`). Labels count up in order of first
  appearance within the file; they are not derived from the names, and no table of names is
  written. It does not hide built-in tool names, known Claude model ids, how many distinct names
  there are or which agents and calls share one. After `-o`, the note on stderr says the names
  were replaced instead of asking you to check them.
- `--round-times <seconds>` hides exact times. The order of everything and rough durations stay;
  a cut idle gap is never rounded below one step.
- `--bucket-tokens` writes each reply's token counts as the nearest of 1, 2, 5, 10, 20, 50, ...
  (0 stays 0); agent and session totals are the sums of those. It hides exact sizes, not rough
  ones.

None of them hides the structure: agents, who started whom, waves, tool calls and their kinds,
failures and replies. The details are in [privacy.md](privacy.md#export-options-opt-in).

A session that only the history store holds is exported from its stored lines, through the same
parser, replay builder and export as a session read from files. When nothing in it was redacted,
the file is the same, byte for byte, as an export made from its transcripts before they were
deleted (a test checks this on the synthetic sessions).

### `orbitrace history`

```text
orbitrace history status   [--json]
orbitrace history enable   [--json]
orbitrace history disable  [--json]
orbitrace history ingest   [--config-dir <path>]... [--extra-roots] [--json]
orbitrace history list     [--config-dir <path>]... [--extra-roots] [--limit <n>] [--json]
orbitrace history delete   (<session-key> | --all) [--yes] [--json]
orbitrace history where    [--json]
```

Keeps a copy of your sessions that outlives Claude Code's cleanup, in the history store of
`@orbitrace/core` (what it keeps, where and how is in
[privacy.md](privacy.md#history-store-25)). **History is off by default.**

- `status`: whether recording is on, whether this Node can run the store (SQLite version), where
  the store is, and how many sessions and lines it holds and its size.
- `enable`: turns recording on. It writes a small settings file, `settings.json`
  (`{ "settings": 1, "historyRecording": true }`), in the data folder, creating the folder (0700)
  and the file (0600). From then on `orbitrace open` copies sessions while it runs (see
  [`orbitrace open`](#orbitrace-open)). It copies nothing itself.
- `disable`: turns recording off. It writes the settings file only when it exists. A running
  `orbitrace open` stops copying before its next copy. What is stored stays until you delete it.
- `ingest`: copies every session under the folders searched (as for `list`) into the store now,
  once, whether recording is on or off, and creates the store when there is none. A second run
  copies only what was added since. On a terminal it shows its progress on stderr; with `--json`
  it writes one document at the end. With no session to copy it writes nothing.
- `list`: the sessions in the store, newest first, with how many lines each holds and whether its
  transcript is still found (`found`) or not (`missing`) in the folders searched.
- `delete <session-key>`: deletes the stored copy of one session (a key from `history list`, or a
  unique start of one, as for `export`). `delete --all` deletes the whole store (the settings
  file stays, so recording stays on if it was on). On a terminal it asks first; `--yes` skips the
  question. Without a terminal, or with `--json`, it deletes nothing without `--yes` and exits
  with `not-confirmed`. Transcripts are never touched. Where this Node cannot read the store,
  `delete --all` still deletes its files (the session count is then left out, `null` in JSON).
- `where`: prints the data folder.

The data folder is `ORBITRACE_DATA_DIR` when it is set (an absolute path), otherwise `.orbitrace`
in your home folder. It may not be inside a git working tree or a Claude Code config folder
(`history-failed`). Paths are shown with your home folder as `~`, as `doctor` shows them.

While recording is off, no command creates the data folder, the settings file or the store
except `history enable` and `history ingest`, which you run to do exactly that (a test runs every
command with recording off and checks). `list`, `export` and `open` look at the store only when
its file exists, and only read it.

When a session has ended (its live status is `ended` and nothing was written to it for a minute),
`ingest` and `open` tell the store so, and a last line Claude Code left without its line break is
then stored once instead of waiting for the rest of the line.

History needs `node:sqlite`, which Node 22.13 and later have. Where it is missing (Node 20),
`status`, `enable`, `ingest`, `list` and `delete <session-key>` say why and exit with 13,
`history-unavailable`; nothing else changes. `disable`, `where` and `delete --all` need no
`node:sqlite` and work on every Node, so you can always turn recording off, find the store and
delete it.
On Node 22 and 23, Node's "SQLite is an experimental feature" warning is held back.

| Exit | When                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Done. Also: nothing to copy, nothing to delete, recording already in the state asked for.                                                                            |
| 2    | `usage`: no subcommand, an unknown one, or an option the subcommand does not take.                                                                                   |
| 3, 5 | `delete`: no stored session has that key (`not-found`), or the start matches more (`ambiguous`).                                                                     |
| 13   | `history-unavailable`: this Node cannot run the store (not `disable`, `where`, `delete --all`).                                                                      |
| 14   | `history-locked`: another process is writing the store (an `open` that records). `delete` waits up to 3 seconds first.                                               |
| 15   | `history-failed`: the data folder is not allowed, the file is not a store or is from a newer Orbitrace, the build has no history worker, or a file operation failed. |
| 16   | `not-confirmed`: `delete` without `--yes` where it cannot ask, or the answer was no.                                                                                 |

The `--json` documents are listed under [JSON output](#json-output).

### `orbitrace doctor`

```text
orbitrace doctor [--config-dir <path>]... [--extra-roots] [--parse-limit <n>] [--json]
```

Checks the set-up and says what is wrong and how to fix it (#31). It reads only: it writes no
file, creates no folder, changes no setting and opens no database file (the history check asks
core whether `node:sqlite` works, which opens a database in memory only). Each fix is a command
to run or a setting to change; doctor never runs it. Run it again after a fix to see the result.

| Option                          | Meaning                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--config-dir`, `--extra-roots` | As for `list`. The checks search the same folders `list` would, found by the same code.                         |
| `--parse-limit <n>`             | The parser check reads at most `n` sessions, newest first. Default: 20. A whole number of at least 1.           |
| `--json`                        | One JSON document on stdout (below) instead of text. The checks, codes and exit codes are the same as for text. |

The report goes to stdout in both forms, and nothing goes to stderr unless the command line
itself is wrong (a `usage` error). The exit code is 0 when no check failed (warnings and skipped
checks are allowed) and 12, `doctor-failed`, when at least one did. It is the only command that
writes its document and still exits non-zero.

Each check reports one status:

- `ok`: nothing to do.
- `warn`: something works less well than it could, for example history recording is on but this
  Node cannot record.
- `fail`: something does not work, for example `open` cannot start.
- `skipped`: there is nothing to check, for example no sessions to parse.

Every `warn` and `fail` carries a `fix`; `ok` and `skipped` carry none.

#### What the report shows

Folder paths, with your home folder written as `~` (`%USERPROFILE%` on Windows). A folder outside
the home folder is shown only when you put it there: with `--config-dir`, `CLAUDE_CONFIG_DIR`,
`APPDATA` or `XDG_CONFIG_HOME`. A relative `--config-dir` value is shown relative to the current
folder (`./cfg`, `../cfg`), never with the current folder's own path, in `session-roots`,
`running-registry` and the `parser-unreadable` fix alike. Besides paths: counts, the line types the parser skipped (by type
name and count), the Claude Code versions the transcripts name, the Node version, the platform and
system error codes such as `EACCES`. It shows no line content, session id, session key or project
name, and never the text of a system error. Check the paths before you paste a report into an
issue.

#### Checks

| Check              | What it checks                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-version`     | The running Node against the `engines.node` range of the command (`>=20`).                                                                                                                                                      |
| `config-folder`    | Which folder Claude Code writes its sessions to and why: `CLAUDE_CONFIG_DIR` when it is set, otherwise `~/.claude` (`%USERPROFILE%\.claude` on Windows). Whether it exists, can be read and has a `projects/` folder.           |
| `session-roots`    | The folders `list` searches, in its order, how each was found, whether it can be read, and how many sessions it holds.                                                                                                          |
| `parser`           | Parses the newest sessions (at most `--parse-limit`): lines that are not valid JSON, lines of a type the parser does not use (by type name and count, at most 20 types listed), unreadable sessions, Claude Code versions seen. |
| `running-registry` | The running-sessions folder (`sessions/`) of each readable config folder, which gives the live status: present, readable, how many sessions it lists and how many of their processes run.                                       |
| `app-bundle`       | The web app that `open` serves: its `index.html` and every file the page loads.                                                                                                                                                 |
| `loopback-port`    | That a free port of `127.0.0.1` can be listened on, as `open` needs. The port is closed at once.                                                                                                                                |
| `history-store`    | Whether this Node can run the history store (core's `historyCapability()`), and whether history recording is on (the settings file of `orbitrace history enable`). With recording off, a Node without `node:sqlite` is skipped. |
| `hooks`            | Always skipped: Orbitrace has no hooks adapter yet (#30).                                                                                                                                                                       |
| `remote-sources`   | Always skipped: remote sources are not built yet (#30).                                                                                                                                                                         |

#### Codes

The codes are stable: a script or an agent may depend on them. A code names one finding; its
status is fixed, except `config-folder-missing`. A code keeps its meaning: a new finding gets a
new code.

| Check              | Code                                   | Status       | Meaning                                                                                                                                                                  |
| ------------------ | -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node-version`     | `node-version-ok`                      | ok           | Node is in the supported range.                                                                                                                                          |
| `node-version`     | `node-version-unsupported`             | fail         | Node is outside the range. Fix: install a supported Node, for example `nvm install --lts`.                                                                               |
| `node-version`     | `node-version-range-unknown`           | skipped      | The command names no range, or one doctor cannot read.                                                                                                                   |
| `config-folder`    | `config-folder-ok`                     | ok           | The config folder exists, can be read and has a `projects/` folder.                                                                                                      |
| `config-folder`    | `config-folder-env-invalid`            | fail         | `CLAUDE_CONFIG_DIR` is set but is not an absolute path, so Orbitrace ignores it.                                                                                         |
| `config-folder`    | `config-folder-no-home`                | fail         | `CLAUDE_CONFIG_DIR` is not set and no home folder is known (`HOME`, or `USERPROFILE` on Windows).                                                                        |
| `config-folder`    | `config-folder-missing`                | warn or fail | The folder does not exist: `fail` when no other session folder can be read, `warn` when one can (for example a `--config-dir` folder).                                   |
| `config-folder`    | `config-folder-not-a-folder`           | fail         | A file is where the config folder should be.                                                                                                                             |
| `config-folder`    | `config-folder-unreadable`             | fail         | The folder or its `projects/` folder exists but cannot be listed by your account. Fix: `chmod -R u+rX <folder>` (`icacls` on Windows).                                   |
| `config-folder`    | `config-folder-projects-not-a-folder`  | fail         | A file is where `projects/` should be. Fix: `mv <folder>/projects <folder>/projects.bak` (`move` on Windows), then run `claude`.                                         |
| `config-folder`    | `config-folder-no-projects`            | warn         | No `projects/` folder: no session has been recorded there yet.                                                                                                           |
| `session-roots`    | `session-roots-ok`                     | ok           | At least one folder can be read and holds sessions.                                                                                                                      |
| `session-roots`    | `session-roots-none`                   | fail         | There is no folder to search: no `--config-dir`, no `CLAUDE_CONFIG_DIR`, no home folder.                                                                                 |
| `session-roots`    | `session-roots-unavailable`            | fail         | None of the folders exists or can be read.                                                                                                                               |
| `session-roots`    | `session-roots-config-dir-unavailable` | warn         | A `--config-dir` folder was not found or cannot be read (the warning `list` gives).                                                                                      |
| `session-roots`    | `session-roots-empty`                  | warn         | The readable folders hold no sessions.                                                                                                                                   |
| `parser`           | `parser-ok`                            | ok           | Every line read was valid JSON. Skipped line types are listed but are not a problem: the parser skips types it does not use by design.                                   |
| `parser`           | `parser-malformed-lines`               | warn         | Some lines were not valid JSON and were skipped. A session that is being written can end in a half-written line.                                                         |
| `parser`           | `parser-unreadable`                    | warn         | Some sessions could not be read. Fix: give your account read access to the session folder.                                                                               |
| `parser`           | `parser-no-sessions`                   | skipped      | No sessions were found to parse.                                                                                                                                         |
| `running-registry` | `running-registry-ok`                  | ok           | At least one config folder has a running-sessions folder that can be read.                                                                                               |
| `running-registry` | `running-registry-missing`             | ok           | No config folder has one, so live status shows as `unknown`. Information only: desktop-only and older set-ups never have it.                                             |
| `running-registry` | `running-registry-not-a-folder`        | fail         | A file is where the folder should be.                                                                                                                                    |
| `running-registry` | `running-registry-unreadable`          | fail         | The folder cannot be listed by your account.                                                                                                                             |
| `running-registry` | `running-registry-no-roots`            | skipped      | No config folder can be read.                                                                                                                                            |
| `app-bundle`       | `app-bundle-ok`                        | ok           | The page and every file it loads are there.                                                                                                                              |
| `app-bundle`       | `app-bundle-missing`                   | fail         | This build has no web app; `open` fails with `app-missing`. Fix: `npm run build`, then run the built command.                                                            |
| `app-bundle`       | `app-bundle-incomplete`                | fail         | Files the page loads are missing (named relative to the app folder). Fix: `npm run build`.                                                                               |
| `loopback-port`    | `loopback-port-ok`                     | ok           | A free port of `127.0.0.1` was listened on and closed.                                                                                                                   |
| `loopback-port`    | `loopback-port-unavailable`            | fail         | Listening failed; `open` cannot start. Fix: allow Node to listen on `127.0.0.1` in the firewall, sandbox or container settings.                                          |
| `history-store`    | `history-store-available`              | ok           | The history store can run here. The message says whether recording is on.                                                                                                |
| `history-store`    | `history-store-not-in-use`             | skipped      | The store cannot run here (`node:sqlite` is missing), and recording is off, so nothing needs it. History needs Node 22.13 or later.                                      |
| `history-store`    | `history-store-unavailable`            | warn         | Recording is on, but the store cannot run here, so nothing is recorded. Fix: install Node 22.13 or later, or `orbitrace history disable`.                                |
| `history-store`    | `history-store-settings-invalid`       | warn         | The history settings file cannot be read, so recording is off. Fix: `orbitrace history enable` or `disable` writes it again (only `disable` where the store cannot run). |
| `hooks`            | `hooks-not-built`                      | skipped      | No hooks adapter yet (#30).                                                                                                                                              |
| `remote-sources`   | `remote-sources-not-built`             | skipped      | No remote sources yet (#30).                                                                                                                                             |
| `any`              | `check-error`                          | fail         | The check itself could not run. The message is fixed text. Fix: run doctor again; if it keeps failing, open an issue with the report.                                    |

#### JSON shape

`orbitrace doctor --json` writes one line. Formatted, with one of its ten checks shown:

```json
{
  "doctor": 1,
  "orbitrace": "0.0.0",
  "node": "20.19.0",
  "platform": "linux",
  "status": "warn",
  "summary": { "ok": 7, "warn": 1, "fail": 0, "skipped": 2 },
  "checks": [
    {
      "id": "history-store",
      "status": "warn",
      "code": "history-store-unavailable",
      "message": "History recording is on, but node:sqlite cannot be loaded in Node 20.19.0, so nothing is recorded; it needs Node 22.13 or later.",
      "fix": "Install Node 22.13 or later (for example 'nvm install 22 && nvm use 22'), then run 'orbitrace doctor' again; or turn recording off with 'orbitrace history disable'.",
      "details": {
        "module": "node:sqlite",
        "available": false,
        "inUse": true,
        "errorCode": null,
        "recording": true,
        "settings": "ok",
        "reason": "This Node.js (v20.19.0) has no node:sqlite module. History needs Node 22.13 or later.",
        "sqliteVersion": null,
        "fts5": null
      }
    }
  ]
}
```

- `doctor` is the version of this shape. It goes up when a field is removed or changes meaning;
  new fields may be added without it.
- `orbitrace` is the command's version, `node` the Node version, `platform` as in
  `process.platform`.
- `status` is `fail` when a check failed, else `warn` when one warned, else `ok`. `summary`
  counts the checks with each status.
- `checks` holds every check once, in the order of the table above. Each has `id`, `status`,
  `code`, `message` (one line), `fix` (a string for `warn` and `fail`, otherwise `null`) and
  `details`.

`details` per check (paths are shown as described above; a folder `state` is `ok`, `missing`,
`not-a-folder` or `unreadable`):

| Check              | `details`                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-version`     | `version`, `range` (or `null`), `satisfies` (`true`, `false`, or `null` when not checked).                                                                                                                                                                                                                                                         |
| `config-folder`    | `env` (`unset`, `set` or `invalid`: whether `CLAUDE_CONFIG_DIR` is set and usable), `path`, `resolvedBy` (`environment` or `os-default`), `reason` (one sentence), `state`, `projects` (the state of `projects/`, or `null` when the folder itself is not `ok`). The last five are `null` when no folder is known.                                 |
| `session-roots`    | `roots` (each with `path`, `resolvedBy`, `reason`, `available`, `sessions`), `sessions` (total), `warnings` (as in `list --json`).                                                                                                                                                                                                                 |
| `parser`           | `limit`, `checked` (sessions tried), `parsed`, `unreadable`, `lines`, `malformed`, `malformedSessions`, `unknownLines`, `unknownByType` (type name to count, at most 20, most common first), `unknownTypesNotListed`, `versions` (Claude Code versions seen, oldest first; at most the 20 newest).                                                 |
| `running-registry` | `folders` (each with `path`, `state`, `entries` and `running`, both `null` unless `state` is `ok`).                                                                                                                                                                                                                                                |
| `app-bundle`       | `present` (`index.html` was found), `files` (how many files the page loads), `missing` (those not found, relative to the app folder).                                                                                                                                                                                                              |
| `loopback-port`    | `host` (`127.0.0.1`), `bound`, `errorCode` (a system error code such as `EACCES`, or `null`).                                                                                                                                                                                                                                                      |
| `history-store`    | `module` (`node:sqlite`), `available`, `inUse` and `recording` (both: whether history recording is on), `settings` (`missing`, `ok`, `invalid`, or `unknown` when no data folder can be worked out), `reason` (why the store cannot run, or `null`), `sqliteVersion` and `fts5` (or `null`), `errorCode` (always `null` since #195; see `reason`). |
| `hooks`            | Empty.                                                                                                                                                                                                                                                                                                                                             |
| `remote-sources`   | Empty.                                                                                                                                                                                                                                                                                                                                             |

## Where sessions are looked for

The folders are found by `@orbitrace/core`, in this order, with duplicates removed:

1. Folders given with `--config-dir`.
2. The `CLAUDE_CONFIG_DIR` environment variable.
3. The default config folder: `~/.claude` on macOS and Linux, `%USERPROFILE%\.claude` on Windows.
4. With `--extra-roots` only: the desktop app's session folders.

Paths reported by hooks are not used by the command line.

## JSON output

With `--json`, every command writes exactly one JSON document, on one line, to stdout and nothing
else. A failure writes nothing to stdout and one JSON object to stderr. Warnings are inside the
document, not on stderr.

| Command                   | Document on stdout                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `--version --json`        | `{ "name", "version", "core" }`                                                          |
| `help --json`             | `{ "name", "version", "commands": [...], "exitCodes": {...} }`                           |
| `list --json`             | `{ "sessions": [SessionSummary...], "warnings": [...] }`                                 |
| `export --json` (stdout)  | `{ "key", "fileName", "output": null, "bytes", "warnings", "options", "replay" }`        |
| `export --json -o <file>` | `{ "key", "fileName", "output": "<file as typed>", "bytes", "warnings", "options" }`     |
| `open --json`             | `{ "url", "origin", "port", "key", "browser", "warnings" }`                              |
| `doctor --json`           | `{ "doctor", "orbitrace", "node", "platform", "status", "summary", "checks" }`           |
| `history status --json`   | `{ "recording", "settings", "capability", "dataDir", "database", "store" }`              |
| `history enable --json`   | `{ "recording": true, "changed", "settings" }`                                           |
| `history disable --json`  | `{ "recording": false, "changed", "settings" }` (`settings` is `null` when unwritten)    |
| `history ingest --json`   | core's ingest result and `{ "database", "warnings" }` (below)                            |
| `history list --json`     | `{ "sessions": [HistoryListEntry...], "warnings": [...] }`                               |
| `history delete <key>`    | `{ "key", "deleted": true, "lines", "scrubbed" }`                                        |
| `history delete --all`    | `{ "all": true, "deleted", "sessions", "recording" }` (`sessions` is `null` when unread) |
| `history where --json`    | `{ "dataDir", "database", "settings", "exists" }`                                        |

The `export --json` document is for scripts. It contains the session key, the `-o` path as typed
and any `--config-dir` path as typed (in a warning), so share the replay file (`-o`) or the
document's `replay` value, not the whole document (finding F7 of
[security/export-audit.md](security/export-audit.md)).

`options` says which export options were applied:
`{ "names": "as-written" | "opaque", "roundTimes": <seconds> | null, "bucketTokens": <boolean> }`.
Without the flags it is `{ "names": "as-written", "roundTimes": null, "bucketTokens": false }`.

A `SessionSummary` has `key`, `runtime`, `projectLabel`, `sessionId`, `lastActivity` (Unix epoch
milliseconds), `live` (`busy`, `idle`, `ended` or `unknown`) and `subagentCount`. It has no path.
The project name and the session id are local data: they are shown to you and are not part of an
export. In `list --json`, a session that only the history store holds also has `"history": true`;
the others have no `history` field.

History documents (paths shown with the home folder as `~`):

- `status`: `recording` (boolean), `settings` (`missing`, `ok` or `invalid`), `capability`
  (`{ "available": true, "engine": "node:sqlite", "nodeVersion", "sqliteVersion", "fts5" }`),
  `dataDir`, `database`, and `store`:
  `{ "exists", "sessions", "files", "lines", "bytes", "error" }` (the counts are `null` without a
  store; `error` is a message when the store could not be read, otherwise `null`).
- `ingest`: `sessions`, `sessionsSkipped`, `files`, `filesMissing`, `filesReset`, `linesRead`,
  `linesAdded`, `linesSkipped` (lines not stored because they were not JSON and a secret pattern
  matched), `redactions`, `durationMs`, `database` (`null` when nothing was copied) and `warnings`.
- A `HistoryListEntry` has `key`, `runtime`, `sessionId`, `projectLabel`, `lastActivity`,
  `firstIngestedAt`, `lastIngestedAt`, `subagentCount`, `lineCount` and `transcript` (`found` or
  `missing`).
- `delete <key>`: `scrubbed` is `false` when another program had the store open, so old copies of
  the deleted lines stay in the store's WAL file until it closes it.

For `open`, the document is written once the server listens, and the command keeps running
after it. `url` is the link with the token. `key` is the session key in the link, or `null` for
the session list. `browser` is `opened`, `failed` (the opener could not start) or `skipped`
(`--no-browser`).

A warning is `{ "code", "message" }`. The codes: `config-dir-unavailable` (a `--config-dir`
folder was not found or cannot be read), `history-unavailable` (a history store exists but this
Node cannot read it, so the sessions only it holds are not listed) and `history-not-recorded`
(`open`: recording is on, but this run cannot record).

An error on stderr:

```json
{
  "error": {
    "code": "not-found",
    "exitCode": 3,
    "message": "No session with that key.",
    "hint": "Run 'orbitrace list' to see the session keys."
  }
}
```

`hint` is left out when there is none. Without `--json`, the same error is written to stderr as
`orbitrace: <message> [<code>]`, followed by the hint on its own line.

## Exit codes

The codes are stable: a script may depend on them. `not-found`, `unreadable`, `invalid` and
`internal` are the `TransportErrorCode` values of `@orbitrace/core`, passed on from its session
replayer.

| Exit | Code                  | Meaning                                                                                                                  |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0    | `ok`                  | Success. Not an error code; listed for completeness.                                                                     |
| 1    | `internal`            | Something unexpected went wrong.                                                                                         |
| 2    | `usage`               | Unknown command or option, missing or bad value, key and `--latest` together.                                            |
| 3    | `not-found`           | No session has that key or key start.                                                                                    |
| 4    | `no-sessions`         | `--latest` was given and no session was found.                                                                           |
| 5    | `ambiguous`           | The key start matches more than one session.                                                                             |
| 6    | `unreadable`          | The session transcript could not be read.                                                                                |
| 7    | `invalid`             | The replay did not pass the replay format check.                                                                         |
| 8    | `output-exists`       | The output file exists and `--force` was not given.                                                                      |
| 9    | `output-unwritable`   | The output file could not be written (missing folder, no permission).                                                    |
| 10   | `port-unavailable`    | `open --port`: the port is in use or may not be used.                                                                    |
| 11   | `app-missing`         | `open`: this build of the command has no web app (run `npm run build`).                                                  |
| 12   | `doctor-failed`       | `doctor`: at least one check failed. The report is still written to stdout.                                              |
| 13   | `history-unavailable` | `history` (not `disable`, `where`, `delete --all`): this Node cannot run the history store (Node 22.13 or later needed). |
| 14   | `history-locked`      | `history`: another process is writing the history store.                                                                 |
| 15   | `history-failed`      | `history`: the store or its folder or settings could not be used (see message).                                          |
| 16   | `not-confirmed`       | `history delete`: no `--yes` where it cannot ask, or the answer was no.                                                  |

## Privacy of messages

No message shows an absolute path from your machine unless you typed that path. Errors from core
carry fixed, path-free text. An unexpected error prints a fixed message, never the text of the
underlying error, because a file system error names the file it failed on. File paths in
`export` messages are shown as you typed them. Control characters in a project name are replaced
with `?` before it is printed. `doctor` shows folder paths with your home folder as `~` (see
[What the report shows](#what-the-report-shows)).

## The bundled web app

The build bundles the command and `@orbitrace/core` into one file, `packages/cli/dist/index.js`
(#120), bundles core's history worker (the package export `@orbitrace/core/history-worker`, #188)
into a second file beside it, `packages/cli/dist/history-worker.js`, which the command starts as a
worker thread for `history ingest` and recording, and copies the built web app (`packages/app/dist`, without its type declarations) into
`packages/cli/dist/app`, so the package carries it for the browser view. The package needs no
other package at run time: its tarball installs on its own (see
[releasing.md](releasing.md#try-the-artefacts)). See the decision on #76
in [architecture.md](architecture.md#how-the-cli-ships-the-web-app-76). `orbitrace open` serves
it; run from the sources (without a build) the command fails with `app-missing`.
