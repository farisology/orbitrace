# Command line

`orbitrace` lists the Claude Code sessions on your machine and exports a structure-only replay of
one of them. Orbitrace is not affiliated with Anthropic.

**Status: not released.** The package is private and not on npm, so `npx orbitrace` does not work
yet (see [Install](#install)). Opening a session in the browser is not available yet; it comes with
the local server (#17).

## Install

Not published. From a clone of the repository:

```sh
npm ci
npm run build
node packages/cli/dist/index.js --help
```

## Commands

| Command                      | What it does                                               |
| ---------------------------- | ---------------------------------------------------------- |
| `orbitrace list`             | Lists sessions, newest first.                              |
| `orbitrace export <key>`     | Writes the replay of one session.                          |
| `orbitrace export --latest`  | Writes the replay of the session with the newest activity. |
| `orbitrace help [<command>]` | Shows help. `orbitrace <command> --help` shows the same.   |
| `orbitrace --version`        | Prints the version and the status of `@orbitrace/core`.    |

`orbitrace` with no command prints the help.

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

### `orbitrace export`

```text
orbitrace export (<session-key> | --latest) [-o <file>] [--force] [--pretty]
                 [--config-dir <path>]... [--extra-roots] [--json]
```

Builds the replay of one session with core's session replayer and writes it with core's
`exportReplay`: the structure-only replay format described in
[replay-format.md](replay-format.md). No message text, tool input or output, file path, command
line, working folder or session id is in it. Agent type names, model ids and MCP server names
are kept as they are, so look at them before you share a file.

| Option                          | Meaning                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<session-key>`                 | A key from `orbitrace list`, or a unique start of one: at least 4 characters of the part after `claude-code:`, with or without that part. |
| `--latest`                      | The session with the newest activity. Give either a key or `--latest`.                                                                    |
| `-o, --output <file>`           | Write to this file. A folder gets `orbitrace.replay.json` inside it. `-` means stdout. Without `-o`, the replay goes to stdout.           |
| `--force`                       | Replace the output file if it exists. Without it, an existing file is never replaced.                                                     |
| `--pretty`                      | Indent the JSON.                                                                                                                          |
| `--config-dir`, `--extra-roots` | As for `list`. Use the same values as for the `list` that gave you the key: the key depends on the folder the session was found in.       |
| `--json`                        | See [JSON output](#json-output).                                                                                                          |

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

| Command                   | Document on stdout                                                        |
| ------------------------- | ------------------------------------------------------------------------- |
| `--version --json`        | `{ "name", "version", "core" }`                                           |
| `help --json`             | `{ "name", "version", "commands": [...], "exitCodes": {...} }`            |
| `list --json`             | `{ "sessions": [SessionSummary...], "warnings": [...] }`                  |
| `export --json` (stdout)  | `{ "key", "fileName", "output": null, "bytes", "warnings", "replay" }`    |
| `export --json -o <file>` | `{ "key", "fileName", "output": "<file as typed>", "bytes", "warnings" }` |

A `SessionSummary` has `key`, `runtime`, `projectLabel`, `sessionId`, `lastActivity` (Unix epoch
milliseconds), `live` (`busy`, `idle`, `ended` or `unknown`) and `subagentCount`. It has no path.
The project name and the session id are local data: they are shown to you and are not part of an
export.

A warning is `{ "code": "config-dir-unavailable", "message" }`.

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

| Exit | Code                | Meaning                                                                       |
| ---- | ------------------- | ----------------------------------------------------------------------------- |
| 0    | `ok`                | Success. Not an error code; listed for completeness.                          |
| 1    | `internal`          | Something unexpected went wrong.                                              |
| 2    | `usage`             | Unknown command or option, missing or bad value, key and `--latest` together. |
| 3    | `not-found`         | No session has that key or key start.                                         |
| 4    | `no-sessions`       | `--latest` was given and no session was found.                                |
| 5    | `ambiguous`         | The key start matches more than one session.                                  |
| 6    | `unreadable`        | The session transcript could not be read.                                     |
| 7    | `invalid`           | The replay did not pass the replay format check.                              |
| 8    | `output-exists`     | The output file exists and `--force` was not given.                           |
| 9    | `output-unwritable` | The output file could not be written (missing folder, no permission).         |

## Privacy of messages

No message shows an absolute path from your machine unless you typed that path. Errors from core
carry fixed, path-free text. An unexpected error prints a fixed message, never the text of the
underlying error, because a file system error names the file it failed on. File paths in
`export` messages are shown as you typed them. Control characters in a project name are replaced
with `?` before it is printed.

## The bundled web app

The build copies the built web app (`packages/app/dist`, without its type declarations) into
`packages/cli/dist/app`, so the package carries it for the browser view (#17). See the decision
on #76 in [architecture.md](architecture.md#how-the-cli-ships-the-web-app-76). Nothing in this
ticket serves it.
