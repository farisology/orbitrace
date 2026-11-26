# Command line

`orbitrace` lists the Claude Code sessions on your machine, opens one in your browser through a
local server, and exports a structure-only replay of one of them. Orbitrace is not affiliated with
Anthropic.

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
| `open --json`             | `{ "url", "origin", "port", "key", "browser", "warnings" }`               |

A `SessionSummary` has `key`, `runtime`, `projectLabel`, `sessionId`, `lastActivity` (Unix epoch
milliseconds), `live` (`busy`, `idle`, `ended` or `unknown`) and `subagentCount`. It has no path.
The project name and the session id are local data: they are shown to you and are not part of an
export.

For `open`, the document is written once the server listens, and the command keeps running
after it. `url` is the link with the token. `key` is the session key in the link, or `null` for
the session list. `browser` is `opened`, `failed` (the opener could not start) or `skipped`
(`--no-browser`).

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
| 10   | `port-unavailable`  | `open --port`: the port is in use or may not be used.                         |
| 11   | `app-missing`       | `open`: this build of the command has no web app (run `npm run build`).       |

## Privacy of messages

No message shows an absolute path from your machine unless you typed that path. Errors from core
carry fixed, path-free text. An unexpected error prints a fixed message, never the text of the
underlying error, because a file system error names the file it failed on. File paths in
`export` messages are shown as you typed them. Control characters in a project name are replaced
with `?` before it is printed.

## The bundled web app

The build copies the built web app (`packages/app/dist`, without its type declarations) into
`packages/cli/dist/app`, so the package carries it for the browser view. See the decision on #76
in [architecture.md](architecture.md#how-the-cli-ships-the-web-app-76). `orbitrace open` serves
it; run from the sources (without a build) the command fails with `app-missing`.
