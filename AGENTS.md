# Instructions for coding agents

These rules apply to every coding agent working in this repository. Humans can read them too: this is the detailed form of [CONTRIBUTING.md](CONTRIBUTING.md).

**Status: nothing is released yet.** Nothing is on npm or an extension marketplace. Every command below is a script in the root `package.json`, and CI runs them. How the packages fit together is in [docs/architecture.md](docs/architecture.md); how to build and try them is in [docs/getting-started.md](docs/getting-started.md). How a release is cut, and how to add a changelog entry, is in [docs/releasing.md](docs/releasing.md); the changes so far are in [CHANGELOG.md](CHANGELOG.md).

## 1. Privacy rules (hard rules)

The repository is public. Anything you write into it is public: code, tests, comments, documentation, examples, commit messages, issue text and pull request text.

- Never write real transcript content: prompts, replies, file contents, tool inputs or outputs, command lines.
- Never write paths from a user's machine (including a home folder path) or project names from a user's machine.
- Never write session ids, email addresses, tokens or secrets.
- Do not open or read transcript files in the Claude Code config folder (`<config>/projects/`). If you need the shape of a transcript, write a script that prints key names and value types only. Never print, copy or quote values.
- Your own session is real data. Do not use your own transcript, or anything from it, as a fixture, example, screenshot or replay file.
- Do not copy code from other projects, including permissively licensed ones. Studying a technique is allowed.

Why: Orbitrace exists to show agent sessions without exposing what was in them. A leak in this repository is a leak of the data the product protects.

## 2. Synthetic fixtures

- Tests and demos use invented data only: invented agent types, file names, tool calls, prompts, timings and ids. Make it obviously fake, for example `example-project` or `src/widget.ts`.
- If you need a synthetic transcript, use the seeded generator in `packages/fixtures` (`@orbitrace/fixtures`): `generateSession` from `@orbitrace/fixtures/generator` for a session in memory, or the committed sessions under `fixtures/config` through `fixturePaths`. A single line may also be written by hand with invented values. See `packages/fixtures/README.md`.
- Never point a source resolver, the CLI or a test at your own Claude Code config folder. Pass an explicit synthetic folder, such as `fixtures/config` or one the generator wrote to a temporary folder.
- `.gitignore` ignores every `*.jsonl` file except those in the root `fixtures/` folder or in any `test/fixtures/` folder. Put transcript fixtures there. A `fixtures/` folder anywhere else is still ignored.
- Do not rely on `.gitignore` alone. Run `git status` before each commit and confirm every file you add is synthetic.

## 3. Branch flow

1. Create a feature branch from `dev`, named for the change and its issue, for example `docs/4-contributor-docs`.
2. Commit on the feature branch only. Never commit directly to `dev` or `main`.
3. Open a pull request with `dev` as the base branch.
4. Never push to `main`. The owner merges `dev` into `main`.

## 4. Before you open a pull request

Run these from the repository root and report the real output:

```sh
npm ci              # on a fresh clone or after a dependency change
npm run build
npm test
npm run lint
npm run typecheck
npm run format:check
npm run privacy
```

- CI (`.github/workflows/ci.yml`) runs these checks on Node 20, 22, 24 and 26, and the VS Code integration test in a separate job on Node 22, on the current stable VS Code and on 1.96.0 (the lowest version `engines.vscode` allows). A failure in any of them, `npm run format:check` and the integration test included, fails the CI run. One more job runs the core tests on `windows-latest` with Node 24; it does not fail the CI run yet (`continue-on-error`).
- What each package tests, what CI runs and what is not tested are in [docs/test-plan.md](docs/test-plan.md). In the app's tests, after `findBy…` or `waitFor`, await `rendererCreated(orrery)` before you read the fake renderer. To find a test that reads an effect too early, run `ORBITRACE_TEST_EFFECT_GAP_MS=30 npm test -w @orbitrace/app`. Do not fix such a test with a retry or a longer timeout.
- If a command fails, fix the cause or report the failure in the pull request. Do not hide it or skip it.
- If you could not run a command, say so and why. Never report a result you did not see.
- `npm run privacy` fails when forbidden strings appear in the files or in their file and folder names. `npm run privacy -- --range <base>..<head>` checks every line your commits add, every path they add or rename to, and every commit message; CI runs both (`.github/workflows/ci.yml`). Findings name the file, line and rule, never the matched text.
- The range check also warns about each commit whose author or committer email is not a noreply address. The warning names the short sha, never the address, and the check still passes; `--strict-authors` turns these warnings into failures. CI does not use it yet.
- Extra private-name patterns come from the git-ignored `.privacy-denylist.local` at the repository root and from the environment variable `ORBITRACE_PRIVACY_DENYLIST`; both apply. Never commit or print them. The details are in [CONTRIBUTING.md](CONTRIBUTING.md#before-you-open-a-pull-request).
- Passing these checks does not prove a change is clean; they only catch known patterns, so also check the privacy rules above by hand.
- Use a Node version that matches `engines` in the root `package.json` (`.nvmrc` names the lowest).
- Fill in every box of the privacy checklist in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

## 5. Keep changes inside one package

- Work inside one package where possible: `core`, `renderer`, `app`, `fixtures`, `vscode` or `cli`.
- `core` has no editor dependency. `renderer` has no UI framework dependency. Do not add one.
- The main entry of `core` imports no Node module; Node-only code goes behind `@orbitrace/core/node`. Tests in `packages/core` and `packages/fixtures` fail otherwise.
- `npm run typecheck` checks the same split. `packages/core/tsconfig.browser.json` checks every file under `packages/core/src` except the Node-only ones, without Node's types; `packages/core/tsconfig.json` checks all of `src` and `test` with them. The Node-only files are `src/sources/node.ts`, everything in `src/sources/claude-code/` and everything in `src/history/` (the history store).
  - A browser-side core file that uses `process` or `Buffer`, or imports a `node:` module, fails with `error TS2591: Cannot find name 'process'` (or `'Buffer'`, `'node:path'`). Do not follow the hint in that message to add `node` to `types`: move the code to a Node-only file.
  - A browser-side core file that imports a Node-only file fails with `error TS6307: File '.../src/sources/claude-code/adapter.ts' is not listed within the file list of project '.../packages/core/tsconfig.browser.json'`.
  - A new Node-only core file goes in `src/sources/claude-code/`, which both lists already cover. Anywhere else, add its path to `exclude` in `packages/core/tsconfig.browser.json` and to `include` in `packages/core/tsconfig.node.build.json`. Both lists must name the same paths.
- If a change has to cross packages, say why in the pull request description.
- Stay inside the issue you were given. Do not build features that belong to another issue. Do not edit root files unless your issue requires it.

## 6. Facts and wording

- State only facts you verified. Mark anything not built as not built.
- Do not guess dependency versions. Check them with `npm view <package> version`.
- Refer to Claude Code descriptively. Where the product is described, say that Orbitrace is not affiliated with Anthropic.
- Write plain, direct English. No marketing language.

What Orbitrace reads, stores and puts in a shared replay is in [docs/privacy.md](docs/privacy.md). Any change to what a shared replay contains must update that page in the same pull request.
