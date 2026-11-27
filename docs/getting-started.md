# Getting started

How to build Orbitrace from a clone of the repository and try what exists today. Orbitrace
replays Claude Code agent sessions as an orrery. It is an independent project and is not
affiliated with or endorsed by Anthropic.

**Nothing is published yet.** There is no package on npm (so `npx orbitrace` does not work) and
no extension on the VS Code Marketplace or Open VSX. Everything below runs from your own build.

## What you can try

- **Web app:** plays a bundled demo session (invented data). You can drop a `.replay.json` file
  or a `.jsonl` transcript onto it.
- **`orbitrace` command:** `list` lists the sessions on your machine, `export` writes a
  structure-only replay file, and `open` shows a session in your browser.
- **VS Code extension:** a Sessions view in the activity bar, and one editor tab per session.

## Prerequisites

- **Git.**
- **Node.js** `^20.19.0 || ^22.13.0 || >=24` (Node 20.19 or a later 20.x, 22.13 or a later 22.x,
  or 24 and later), with the npm that comes with it. Check with `node --version`. With nvm,
  `nvm use` in the repository reads `.nvmrc`.
- **VS Code 1.96 or later**, only for the extension.
- The examples use a POSIX shell (macOS, Linux or WSL).

## Clone and build

Work is merged into the `dev` branch first; `main` can be behind it.

```sh
git clone https://github.com/farisology/orbitrace.git
cd orbitrace
git switch dev
npm ci
npm run build
```

`npm ci` installs every package's dependencies from the lockfile. `npm run build` builds every
package in dependency order, core first and the web app before the command line and the
extension, which both copy the built web app into their own `dist/app`.

To check your build, run the same commands CI runs:

```sh
npm test
npm run lint
npm run typecheck
npm run privacy
```

## Run the web app with the demo

```sh
npm run dev -w @orbitrace/app
```

Vite prints a local address on `127.0.0.1`; open it in a browser. With no host (no editor and no
`orbitrace open` server) the app shows its bundled demo: a synthetic session with fourteen
subagents. Press Space to play and pause, the arrow keys to scrub, and click an agent to inspect
it. `npm run preview -w @orbitrace/app` serves the production build from `packages/app/dist`
instead.

You can drop a file anywhere on the page, or use Open file. A `.replay.json` file is checked
against the replay format. A `.jsonl` transcript is parsed in the page; one transcript file holds
the main agent only, because subagent transcripts are separate files. The file is read in the
page and is not sent anywhere. To try this with invented data, drop
`fixtures/replays/two-waves.replay.json` from the repository.

## Run the `orbitrace` command

The command is not installed anywhere: run the built file with Node.

```sh
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js --version
```

| Command  | What it does                                                                     |
| -------- | -------------------------------------------------------------------------------- |
| `list`   | Lists sessions, newest first: key, last activity, status, subagents, project.    |
| `export` | Writes the structure-only replay of one session.                                 |
| `open`   | Opens a session in your browser through a local server. Ctrl+C stops it.         |

Run each one as `node packages/cli/dist/index.js <command>`.

Every option, the JSON output and the exit codes are in [cli.md](cli.md).

By default the command reads your own Claude Code config folder (`CLAUDE_CONFIG_DIR`, or
`~/.claude`). `--config-dir <folder>` adds another folder and searches it first; it does not
replace the default folders.

### Try it on synthetic sessions only

The repository has a synthetic config folder, `fixtures/config`, with invented sessions. To see
only those, point the command at it and hide your own config folder for that one command: set
`HOME` to an empty temporary folder and `CLAUDE_CONFIG_DIR` to nothing.

Run these from the repository root:

```sh
sandbox="$(mktemp -d)"
orbitrace_demo() { HOME="$sandbox" CLAUDE_CONFIG_DIR= node packages/cli/dist/index.js "$@"; }

orbitrace_demo list --config-dir fixtures/config
```

You can also write a fresh synthetic folder with the fixture generator and use that instead:

```sh
node packages/fixtures/dist/cli.js --out "$sandbox/fixtures"
orbitrace_demo list --config-dir "$sandbox/fixtures/config"
```

Then export one session and open one in the browser:

```sh
# Write orbitrace.replay.json into the sandbox folder. -o - (or no -o) writes to stdout.
orbitrace_demo export --latest --config-dir fixtures/config -o "$sandbox"

# Start the local server and open the newest session. Ctrl+C stops it.
orbitrace_demo open --config-dir fixtures/config
```

Use the same `--config-dir` for `export` and `open` as for the `list` that gave you a session
key: a key depends on the folder the session was found in. A key, or its first four or more
characters after `claude-code:`, can replace `--latest`.

`open` prints a link with a one-time token. Anyone who has the link can read the sessions the
command can see while it runs, so do not share it. Use `--no-browser` to print the link without
opening a browser.

Without the `HOME` and `CLAUDE_CONFIG_DIR` overrides, the same commands list, export and open
your own sessions. An exported replay holds no message text, file path, command line or session
id, but agent type names and MCP server names are kept as they are, so look at them before you
share a file. See [privacy.md](privacy.md#what-a-shared-replay-contains).

## Build and install the extension by hand

After `npm run build` at the repository root, `packages/vscode/dist` holds the bundled extension
and its copy of the web app. Package it with `vsce`, which `npx` downloads from npm (it is not a
dependency of this repository), and install the `.vsix` file:

```sh
cd packages/vscode
npx @vscode/vsce package --no-dependencies --out <folder outside the repository>
code --install-extension <folder outside the repository>/orbitrace-vscode-0.0.0.vsix
```

`--no-dependencies` is needed because everything the extension runs is already bundled into
`dist/extension.js`. Write the `.vsix` outside the repository so it is not committed.

Then click the Orbitrace icon in the activity bar. The Sessions view lists the Claude Code
sessions on the machine the workspace is on, the open workspace folder's sessions first. Press
Visualise (the play button in the view title) or click a session. Without sessions, the view
offers **Open demo**. The commands are listed in
[packages/vscode/README.md](../packages/vscode/README.md).

The extension reads `CLAUDE_CONFIG_DIR` or `~/.claude` only. It has no setting to point it at
another folder, so to see only synthetic sessions, use **Open demo**.

To remove it, uninstall Orbitrace from the Extensions view.

## Where to go next

- [architecture.md](architecture.md): the packages, the data flow and where each piece lives.
- [replay-format.md](replay-format.md): what a replay file holds.
- [privacy.md](privacy.md): what Orbitrace reads, stores and puts in a shared replay.
- [cli.md](cli.md): the command line in full.
- [CONTRIBUTING.md](../CONTRIBUTING.md): how to contribute.
