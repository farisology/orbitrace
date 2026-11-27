# Contributing to Orbitrace

Orbitrace replays Claude Code agent sessions as an orrery: the main agent in the centre, subagents in orbit, each tool call a flare. It is MIT licensed. It is an independent project and is not affiliated with Anthropic.

**Status: nothing is released yet.** Nothing is on npm or an extension marketplace, so there is no install step for users. To build and try what exists, see [docs/getting-started.md](docs/getting-started.md).

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

You need npm and a Node.js version that matches `engines` in the root `package.json`: `^20.19.0 || ^22.13.0 || >=24`, that is Node 20.19 or a later 20.x, Node 22.13 or a later 22.x, or Node 24 or later. `.nvmrc` names `20.19`, the lowest supported line. CI builds and tests on Node 20 and 22.

The floor comes from the `engines` fields of the build tools (checked on 27 Nov 2026 against the installed versions):

| Package | Version | `engines.node` |
| --- | --- | --- |
| `vite` | 8.3.8 | `^20.19.0 \|\| >=22.12.0` |
| `@vitejs/plugin-react` | 6.3.0 | `^20.19.0 \|\| >=22.12.0` |
| `eslint` | 10.15.0 | `^20.19.0 \|\| ^22.13.0 \|\| >=24` |
| `vitest` | 4.1.12 | `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` |
| `typescript-eslint` | 8.74.0 | `^18.18.0 \|\| ^20.9.0 \|\| >=21.1.0` |

The root range is where all five overlap. Two exceptions: `npm run bench:browser` in `packages/renderer` needs Node 22 or later (`npm run bench:node`, the Node benchmarks next to it, does not), and `@vitest/eslint-plugin` 1.6.28 (a lint plugin) declares `>=22`, so npm may print an engine warning for it on Node 20. CI runs the lint step on Node 20 as well as 22. The `orbitrace` command in `packages/cli` keeps its own `engines` field (`>=20`), which is about running the built command, not building it.

The repository uses npm workspaces with these packages:

| Package | Purpose |
| --- | --- |
| `core` | Transcript parser, source resolution, replay model builder and export. No editor dependency. Node-only parts are on `@orbitrace/core/node`. |
| `renderer` | Framework-free Canvas 2D engine that draws a replay model. |
| `app` | React and Vite shell that hosts the renderer and talks to its host through a transport interface. |
| `fixtures` | Seeded generator of synthetic transcripts and the golden replay files. For tests and the demo; private. |
| `vscode` | VS Code extension. |
| `cli` | Command-line entry: `orbitrace list`, `export` and `open`. |

A `plugin` package for Claude Code is planned for later. How the packages fit together is in [docs/architecture.md](docs/architecture.md).

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

- CI (`.github/workflows/ci.yml`) runs the same commands on Node 20 and 22 for every pull request into `dev` or `main` and every push to `dev`. It also runs `npm run privacy -- --range <base>..<head>`, which checks every line the new commits add, every path they add or rename to, and every commit message. Run that yourself before you push, with `dev` as the base.
- `npm run privacy` checks file and folder names as well as file contents. A finding prints `file:line: rule` and never the matched text; line `0` means the path itself matched, and the matched part of the path is printed as `[redacted]`.
- The range check also looks at the author and committer email of each commit, because a merge publishes them. An address that is not a noreply address (such as `<id>+<user>@users.noreply.github.com`) is a warning that names the commit's short sha, never the address, and the check still passes. `--strict-authors` turns these warnings into failures. CI does not use it yet; the owner decides when CI switches to strict.
- Extra private-name patterns (one regular expression per line, case-insensitive, `#` for comments) come from the git-ignored `.privacy-denylist.local` at the repository root and from the environment variable `ORBITRACE_PRIVACY_DENYLIST`; both apply. A bad pattern is reported by its line number only, never printed. In CI the variable is filled from a repository secret of the same name on pushes to `dev` only, so pull requests (including those from forks, which get no secrets) use the built-in patterns. The secret is optional; the owner may add it under the repository's Actions secrets.
- Passing `npm run privacy` does not prove a change is clean: it only catches known patterns. Also work through the privacy checklist in the pull request template.
- Paste the real result of each command into the pull request. If a command fails, say so. Do not leave it out.

## Other checks

These are not part of `npm test`. Run them when your change touches what they cover.

- **VS Code integration test.** `npm run test:integration -w orbitrace-vscode`, after `npm run build`, with Node 22 or later. It downloads VS Code into `packages/vscode/node_modules/.cache/vscode-test/` and runs the built extension in a real window against synthetic sessions only. CI runs it in a separate job that does not block a merge yet. What it checks and its settings are in [packages/vscode/README.md](packages/vscode/README.md#integration-test).
- **Benchmarks.** In `packages/renderer`, after `npm run build` at the root: `npm run bench:node` (draw path and parse/build in Node) and `npm run bench:browser` (draw benchmark in headless Chrome, Node 22 or later). `bench:browser` reads `BENCH_DPR` (default 2), `BENCH_CPU_THROTTLE` (default 1) and `BENCH_AGENTS` (default `15,100,500`), and `CHROME_PATH`. The targets and the last measured results are in [docs/performance.md](docs/performance.md); the commands are also in [packages/renderer/README.md](packages/renderer/README.md#commands).
- **Accessibility.** The WCAG 2.1 AA audit of the app shell, its fixes, what still needs a person with a screen reader, and how to run the checks are in [packages/app/ACCESSIBILITY.md](packages/app/ACCESSIBILITY.md#running-the-checks).
- **Export privacy.** The field-by-field audit of what can reach a shared replay, with its findings and the tests that guard them, is [docs/security/export-audit.md](docs/security/export-audit.md). A change to what a replay contains updates [docs/privacy.md](docs/privacy.md) in the same pull request.

## Releases and the changelog

Nothing is released yet. How a release is cut, what it publishes, and a local dry run of the packaging (`node scripts/release/pack-release.mjs`, with the pinned `@vscode/vsce` and `ovsx` in `scripts/release/tools/`) are in [docs/releasing.md](docs/releasing.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md); docs/releasing.md says how to add an entry.

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
