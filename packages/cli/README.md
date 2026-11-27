# orbitrace

The Orbitrace command line. It lists the Claude Code sessions on your machine, opens one in
your browser as an orrery (the main agent in the centre, subagents in orbit) through a local
server, and exports a structure-only replay file of one session.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** This package is not on npm yet, so `npx orbitrace` does not work.
Build it from the [repository](https://github.com/farisology/orbitrace) (see
[getting started](https://github.com/farisology/orbitrace/blob/main/docs/getting-started.md#run-the-orbitrace-command)).

## Commands

| Command                      | What it does                                           |
| ---------------------------- | ------------------------------------------------------ |
| `orbitrace`                  | The same as `orbitrace open`.                          |
| `orbitrace open [<key>]`     | Opens a session in your browser; runs until Ctrl+C.    |
| `orbitrace list`             | Lists sessions, newest first.                          |
| `orbitrace export <key>`     | Writes the structure-only replay of one session.       |
| `orbitrace export --latest`  | Writes the replay of the session with newest activity. |
| `orbitrace help [<command>]` | Shows help.                                            |
| `orbitrace --version`        | Prints the version.                                    |

Every option, the `--json` output and the exit codes are in
[docs/cli.md](https://github.com/farisology/orbitrace/blob/main/docs/cli.md).

By default the command reads the Claude Code config folder (`CLAUDE_CONFIG_DIR`, or `.claude`
in your home folder). It only reads; it never writes there. An exported replay holds no message
text, file path, command line or session id; see
[privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md).

Needs Node.js 20 or later.

## Licence

MIT. See [LICENSE](LICENSE).
