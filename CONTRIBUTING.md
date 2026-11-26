# Contributing to Orbitrace

Orbitrace replays Claude Code agent sessions as an orrery: the main agent in the centre, subagents in orbit, each tool call a flare. It is MIT licensed and is not affiliated with or endorsed by Anthropic.

**Status: nothing is released yet.** There is no install step for users. The contributor commands below are the standard ones. They become runnable when the workspace scaffold lands.

## The three things to know first

1. **Branch flow.** Branch from `dev`. Open a pull request into `dev`. The owner merges `dev` into `main`. Never push to `main`.
2. **Test commands.** From the repository root: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run privacy`. Details in [Before you open a pull request](#before-you-open-a-pull-request).
3. **Privacy rules.** The repository is public. Never commit real session content: no prompts, replies, file contents, command lines, paths, project names, session ids, emails or secrets. Tests use synthetic fixtures only. Full rules: [docs/privacy.md](docs/privacy.md) and [AGENTS.md](AGENTS.md).

## Branch flow

1. Start from `dev`.
2. Create a feature branch named for the change, for example `docs/4-contributor-docs`.
3. Commit on that branch.
4. Open a pull request with `dev` as the base branch. Fill in the pull request template, including the privacy checklist.
5. The owner merges `dev` into `main` when a set of changes is ready. Contributors do not merge into `main`.

`main` is never pushed to directly.

## Setup

You need Node.js 20 or later and npm. The project uses npm workspaces.

```sh
npm ci
```

Run `npm ci` from the repository root to install the dependencies for every package.

The packages are:

| Package | Purpose |
| --- | --- |
| `core` | Transcript parser, source resolution, replay model builder and export. No editor dependency. |
| `renderer` | Framework-free Canvas 2D engine that draws a replay model. |
| `app` | React and Vite shell that hosts the renderer. |
| `vscode` | Editor extension. |
| `cli` | Command-line entry. |
| `plugin` | Claude Code plugin. Planned for later. |

The folder layout and the exact package names are set by the workspace scaffold ticket.

## Before you open a pull request

Run these from the repository root, in this order:

```sh
npm ci            # after dependency changes, or on a fresh clone
npm run build
npm run typecheck
npm run lint
npm test
npm run privacy
```

- `build` builds the packages.
- `typecheck` checks the TypeScript types.
- `lint` runs the linter.
- `test` runs the test suite. Tests use synthetic fixtures only.
- `privacy` runs the privacy checks. Its checks are part of the scaffold ticket and are not built yet.

Paste the results into your pull request. If a command does not exist yet, say so in the pull request. Do not skip it silently.

## Keep changes inside one package

Where possible, a change touches one package. If it must touch more, say why in the pull request description. The dependency direction matters: `core` must not depend on an editor, and `renderer` must not depend on a UI framework.

## Privacy rules

- Never write real transcript content into any file, commit, issue or pull request. This includes examples in documentation.
- Tests and demos use invented data: invented agent names, file names and prompts.
- Transcript fixtures live under `fixtures/` or `test/fixtures/`. `.gitignore` ignores every other `*.jsonl` file. Check `git status` before each commit anyway.
- Do not put a home folder path, a project name from your machine, or an email address in any file.
- Do not copy code from other projects. Studying a technique is fine.

The full rules are in [docs/privacy.md](docs/privacy.md) and [AGENTS.md](AGENTS.md).

## Reporting bugs and requesting features

Use the issue templates:

- [Bug report](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature request](.github/ISSUE_TEMPLATE/feature_request.md)

Do not paste transcripts, prompts, file contents or paths into an issue. Describe the problem with a small invented example.

## Reporting security problems

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone who takes part in this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Orbitrace is licensed under the MIT licence. See [LICENSE](LICENSE). Contributions are accepted under the same licence.
