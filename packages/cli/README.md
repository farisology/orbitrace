# orbitrace

The Orbitrace command line. It lists the Claude Code sessions on your machine, opens one in
your browser as an orrery (the main agent in the centre, subagents in orbit) through a local
server, and exports a structure-only replay file of one session. When you turn it on, it also
keeps a copy of your sessions that outlives Claude Code's cleanup.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** This package is not on npm yet, so `npx orbitrace` does not work.
Build it from the [repository](https://github.com/farisology/orbitrace) (see
[getting started](https://github.com/farisology/orbitrace/blob/main/docs/getting-started.md#run-the-orbitrace-command)).

## Commands

| Command                          | What it does                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `orbitrace`                      | The same as `orbitrace open`.                                                                     |
| `orbitrace open [<key>]`         | Opens a session in your browser; runs until Ctrl+C.                                               |
| `orbitrace list`                 | Lists sessions, newest first.                                                                     |
| `orbitrace export <key>`         | Writes the structure-only replay of one session.                                                  |
| `orbitrace export --latest`      | Writes the replay of the session with newest activity.                                            |
| `orbitrace history status`       | Says whether recording is on, whether this Node can run the store, where it is and what it holds. |
| `orbitrace history enable`       | Turns recording on: from then on `orbitrace open` copies sessions into the store while it runs.   |
| `orbitrace history disable`      | Turns recording off. What is stored stays until you delete it.                                    |
| `orbitrace history ingest`       | Copies every session found into the store now, once, whether recording is on or off.              |
| `orbitrace history list`         | Lists the stored sessions, newest first, and whether each transcript is still found.              |
| `orbitrace history delete <key>` | Deletes one stored session. Asks first on a terminal. The transcript is not touched.              |
| `orbitrace history delete --all` | Deletes the whole store. Asks first on a terminal. Transcripts are not touched.                   |
| `orbitrace history where`        | Prints the folder the store is in.                                                                |
| `orbitrace doctor`               | Says what is wrong with the set-up and how to fix it. Changes nothing.                            |
| `orbitrace help [<command>]`     | Shows help.                                                                                       |
| `orbitrace --version`            | Prints the version.                                                                               |

Every option, the `--json` output and the exit codes are in
[docs/cli.md](https://github.com/farisology/orbitrace/blob/main/docs/cli.md).

By default the command reads the Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `.claude`
in your home folder). It only reads; it never writes there. An exported replay holds no message
text, file path, command line or session id; see
[privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md).

## History

History is off by default. The store and a small settings file go in the data folder:
`ORBITRACE_DATA_DIR` when set (an absolute path), otherwise `.orbitrace` in your home folder.
Only `history enable` and `history ingest` create that folder, and only `history ingest` and an
`open` with recording on write to the store. The store keeps your content (prompts, replies,
tool inputs and outputs) with known secret formats redacted, so treat it as being as sensitive
as the transcripts. Sessions that only the store holds are listed, exported and opened like the
others. See
[history store](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md#history-store-25).

History needs Node.js 22.13 or later. On an older Node, `history disable`, `history where` and
`history delete --all` still work, and the other history commands exit with 13
(`history-unavailable`).

The package ships two JavaScript files: `dist/index.js`, the command, and
`dist/history-worker.js`, the worker thread that copies sessions into the store. Keep them in the
same folder.

## Requirements

Node.js 20 or later.

## Licence

MIT. See [LICENSE](LICENSE).
