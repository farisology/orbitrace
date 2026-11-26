# Orbitrace: Agent Session Visualizer

Replays Claude Code agent sessions as an orrery in an editor tab: the main agent in the centre, subagents in orbit, each tool call a flare.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** The extension is not on the VS Code Marketplace or Open VSX yet. Build it from source (below).

## Use

1. Click the Orbitrace icon in the activity bar. The **Sessions** view lists the Claude Code sessions on this machine: the sessions of the open workspace folder first, then the rest, newest first.
2. Press **Visualise** (the play button in the view title), or click a session.

Commands (Command Palette):

| Command                              | What it does                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Orbitrace: Visualise current session | Opens the newest session of the open workspace folder. With none, the newest session on the machine. With no sessions at all, the demo. |
| Orbitrace: Visualise session...      | Lets you choose a session.                                                                                                              |
| Orbitrace: Open demo                 | Opens the bundled demo replay, made from invented data.                                                                                 |
| Orbitrace: Refresh sessions          | Lists the sessions again.                                                                                                               |

Each session opens in its own tab. Running the command again for the same session brings its tab to the front. The extension sends live updates to a tab while it is open; whether the picture moves with them depends on the web app's editor transport and on file watching in core, which are separate pieces of work.

A session belongs to the workspace when Claude Code was started in the workspace folder itself. A session started in a subfolder is listed under "Other projects".

## Remote machines

The extension runs where the workspace is (`extensionKind: workspace`). Over Remote SSH, in a dev container or in WSL it reads the Claude Code folders of the remote machine, which is where those sessions are written.

## Where sessions are read from

The Claude Code config folder: `CLAUDE_CONFIG_DIR` when the extension host has it set, otherwise `.claude` in the home folder. Files are only read, never written.

## Privacy

- Transcripts are read on the machine they are on. Nothing is uploaded.
- The editor tab gets session summaries (project name, last activity, status, subagent count) and structure-only replays. It never gets transcript text, file paths or command lines.
- The tab's Content-Security-Policy allows scripts, styles and images only from the extension's own files and blocks every network request (`connect-src 'none'`).
- The Sessions view does not show session ids.

What a replay contains is described in the repository's `docs/privacy.md` and `docs/replay-format.md`.

## Build from source

From the repository root, with Node.js 20 or later:

```sh
npm ci
npm run build
cd packages/vscode
npx @vscode/vsce package --no-dependencies --out <folder outside the repository>
code --install-extension <folder outside the repository>/orbitrace-vscode-0.0.0.vsix
```

`npm run build` bundles the extension and `@orbitrace/core` into one file (`dist/extension.js`) with esbuild and copies the built web app into `dist/app`. The `.vsix` holds only those, the icon, this readme and the licence.

## Licence

MIT. See [LICENSE](LICENSE).
