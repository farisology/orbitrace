# Contributing to Orbitrace

Orbitrace replays Claude Code agent sessions as an orrery: the main agent in the centre, subagents in orbit, each tool call a flare. It is MIT licensed. It is an independent project and is not affiliated with Anthropic.

**Status: nothing is released yet.** There is no install step for users. The workspace scaffold (issue #1) is being built, so the commands below are the standard commands the scaffold adds. Some of them do not run yet.

## Start here

1. **Branch flow.** Create a feature branch from `dev`. Open a pull request into `dev`. The owner merges `dev` into `main`. Never push to `main`.
2. **Commands before a pull request.** From the repository root: `npm ci`, `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run privacy`.
3. **Privacy rules.** The repository is public. Never commit real session content: no prompts, replies, file contents, command lines, paths from your machine, project names, session ids, emails or secrets. Tests use synthetic fixtures only.

Coding agents: read [AGENTS.md](AGENTS.md) as well. It has the same rules in more detail.

## Branch flow

1. Clone the repository and switch to `dev`, or update your copy of `dev`:

   ```sh
   git clone https://github.com/farisology/orbitrace.git
   cd orbitrace
   git switch dev
   ```

2. Create a feature branch named for the change, for example `docs/4-contributor-docs` or `feat/6-transcript-parser`. Putting the issue number in the name helps.
3. Commit on that branch.
4. Open a pull request with `dev` as the base branch and fill in the template, including the privacy checklist.
5. The owner merges `dev` into `main`. Contributors do not open pull requests into `main` and never push to it.

## Setup

You need Node.js 20 or later and npm. The repository uses npm workspaces with these packages:

| Package | Purpose |
| --- | --- |
| `core` | Transcript parser, source resolution, replay model builder and export. No editor dependency. |
| `renderer` | Framework-free Canvas 2D engine that draws a replay model. |
| `app` | React and Vite shell that hosts the renderer and talks to its host through a transport interface. |
| `vscode` | VS Code extension. |
| `cli` | Command-line entry. |

A `plugin` package for Claude Code is planned for later. The folder layout is set by the scaffold ticket (#1).

Install every package's dependencies from the repository root:

```sh
npm ci
```

## Before you open a pull request

Run these from the repository root:

```sh
npm ci              # on a fresh clone or after a dependency change
npm run build       # build every package
npm test            # run the tests (Vitest, synthetic fixtures only)
npm run lint        # run ESLint
npm run typecheck   # check TypeScript types (strict mode)
npm run privacy     # fail if forbidden strings appear
```

- These scripts are added by the scaffold ticket (#1), which is not merged yet. The CI pipeline (#3, not built yet) will run them on Node 20 and 22 for every pull request. Until then, run what exists and work through the privacy checklist in the pull request template by hand.
- Paste the real result of each command into the pull request. If a command fails or does not exist yet, say so. Do not leave it out.

## Keep changes inside one package

Where possible, a change touches one package. If it has to touch more than one, say why in the pull request. Keep the dependency direction: `core` must not depend on an editor, and `renderer` must not depend on a UI framework.

Stay inside the issue you are working on. Open a new issue for anything else you find.

## Privacy rules

- Never write real transcript content into a file, commit message, issue or pull request. Examples in documentation count.
- Tests and demos use invented data: invented agent names, file names, prompts and timings.
- Screenshots, screen recordings and replay files attached to issues or pull requests come from synthetic sessions only. A real replay can still show agent and MCP server names you chose.
- `.gitignore` ignores every `*.jsonl` file except those in the root `fixtures/` folder or in any `test/fixtures/` folder. Put synthetic transcript fixtures there, and run `git status` before each commit anyway.
- Do not copy code from other projects. Studying how another project solves a problem is fine.

What Orbitrace reads, stores and shares is in [docs/privacy.md](docs/privacy.md).

## Issues

Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.md) or [feature request](.github/ISSUE_TEMPLATE/feature_request.md) template. Do not paste transcripts, prompts, file contents or paths. Describe the problem with a small invented example.

Do not report security problems in a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Orbitrace is MIT licensed. See [LICENSE](LICENSE). Contributions are accepted under the same licence.
