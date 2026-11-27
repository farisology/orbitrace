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
  structure-only replay file, `open` shows a session in your browser, and `doctor` checks the
  set-up and says how to fix what is wrong.
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

Checks that are not part of `npm test`, each described where it is linked:

- The VS Code integration test, with Node 22 or later:
  `npm run test:integration -w orbitrace-vscode`. It downloads VS Code and runs the built
  extension in a real window against synthetic sessions. See
  [packages/vscode/README.md](../packages/vscode/README.md#integration-test).
- The renderer benchmarks, in `packages/renderer`: `npm run bench:node` and
  `npm run bench:browser` (Node 22 or later; settings `BENCH_DPR`, `BENCH_CPU_THROTTLE` and
  `BENCH_AGENTS`). See [performance.md](performance.md).
- The privacy check's flags (`--range`, `--strict-authors`) and its extra patterns
  (`ORBITRACE_PRIVACY_DENYLIST`). See
  [CONTRIBUTING.md](../CONTRIBUTING.md#before-you-open-a-pull-request).

## Run the web app with the demo

```sh
npm run dev -w @orbitrace/app
```

Vite prints a local address on `127.0.0.1`; open it in a browser. With no host (no editor and no
`orbitrace open` server) the app shows its bundled demo: a synthetic session with fourteen
subagents. Press Space to play and pause, the arrow keys to scrub, and click an agent to inspect
it. The keyboard paths and the accessibility audit of the app are in
[packages/app/ACCESSIBILITY.md](../packages/app/ACCESSIBILITY.md).
`npm run preview -w @orbitrace/app` serves the production build from `packages/app/dist` instead.

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

| Command  | What it does                                                                  |
| -------- | ----------------------------------------------------------------------------- |
| `list`   | Lists sessions, newest first: key, last activity, status, subagents, project. |
| `export` | Writes the structure-only replay of one session.                              |
| `open`   | Opens a session in your browser through a local server. Ctrl+C stops it.      |
| `doctor` | Checks the set-up and says what is wrong and how to fix it. Changes nothing.  |

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

### Follow a running session

A session that is still running opens at the live edge, the newest moment, and keeps up on its
own as Claude Code writes to it. Scrubbing back with the arrow keys, Home or Pause stops
following and leaves the view where you put it. The **Go live** button or the End key returns to
the live edge. The Live badge in the header says `Live: working, following`, or how far behind
the view is, for example `Live: idle, 2 min 5 s behind`. When the session ends, the view becomes
an ordinary replay.

Whether a session is running comes from Claude Code's session registry, and `list` shows it in
the LIVE column (`busy`, `idle`, `ended` or `unknown`). The sessions in `fixtures/config` have no
registry, so they show as `unknown` and open at the start. The details are in
[packages/app/README.md](../packages/app/README.md).

Without the `HOME` and `CLAUDE_CONFIG_DIR` overrides, the same commands list, export and open
your own sessions. An exported replay holds no message text, file path, command line or session
id, but agent type names and MCP server names are kept as they are, so look at them before you
share a file. See [privacy.md](privacy.md#what-a-shared-replay-contains).

### Export from the app

The app can export the replay it shows, in the browser tab `open` starts, in the web app with the
demo, and in the extension's session tabs. Press **Export** in the header. The dialog offers the
same three privacy options as `orbitrace export`, all off: **Opaque names**
(`--opaque-names`), **Round times** with a step in seconds (`--round-times`) and **Bucket
tokens** (`--bucket-tokens`). Each says what it hides and what it does not; the details are in
[privacy.md](privacy.md#export-options-opt-in).

The file is made by the same `exportReplay` as the command: with no option chosen it is the same,
byte for byte, as `orbitrace export` writes for that session. A running session is exported as it
is at that moment. The suggested file name is `orbitrace.replay.json`, the same as the command
gives, with no project or session name in it.

- In a browser the file is downloaded where your browser puts downloads.
- In an editor tab the extension asks where to save it, with the editor's save dialog. The
  extension's demo tab has no Export button.

The public replay player has no export.

## Build and install the extension by hand

After `npm run build` at the repository root, `packages/vscode/dist` holds the bundled extension
and its copy of the web app. Package it with the release script, which uses the copy of
`@vscode/vsce` pinned in `scripts/release/tools/` (Node.js 22 or later), and install the `.vsix`
file. From the repository root:

```sh
(cd scripts/release/tools && npm ci --ignore-scripts)
out="$(mktemp -d)/artefacts"
node scripts/release/pack-release.mjs --out "$out"
code --install-extension "$out"/orbitrace-vscode-0.0.0.vsix
```

`--out` must be an empty folder outside the repository, so nothing it writes is committed. The
script also packs and checks the npm tarballs; what it writes is in
[releasing.md](releasing.md#a-local-dry-run).

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
- [ledger.md](ledger.md): the token totals and cost estimate in the inspector.
- [player.md](player.md): the public replay player.
- [performance.md](performance.md): performance targets, benchmarks and results.
- [security/export-audit.md](security/export-audit.md): the audit of what can reach a shared
  replay.
- [releasing.md](releasing.md) and [CHANGELOG.md](../CHANGELOG.md): how a release is cut, and
  what changed.
- [CONTRIBUTING.md](../CONTRIBUTING.md): how to contribute.
