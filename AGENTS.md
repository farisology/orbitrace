# Instructions for coding agents

These rules apply to every coding agent working in this repository. Humans can read them too: this is the detailed form of [CONTRIBUTING.md](CONTRIBUTING.md).

**Status: nothing is released yet.** The workspace scaffold (issue #1) is not merged, so some commands below do not run yet. When one does not run, say so in your pull request.

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
- If you need a sample transcript line, write it by hand with invented values. A seeded fixture generator is planned in issue #9 and is not built yet.
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
npm run privacy
```

- If a command fails, fix the cause or report the failure in the pull request. Do not hide it or skip it.
- If a command does not exist yet, write "not built yet" in the pull request.
- `npm run privacy` fails when forbidden strings appear (scaffold ticket, #1). Until it exists, check the privacy rules above by hand. Passing it does not prove a change is clean; it only catches known patterns.
- Fill in every box of the privacy checklist in [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

## 5. Keep changes inside one package

- Work inside one package where possible: `core`, `renderer`, `app`, `vscode` or `cli`.
- `core` has no editor dependency. `renderer` has no UI framework dependency. Do not add one.
- If a change has to cross packages, say why in the pull request description.
- Stay inside the issue you were given. Do not build features that belong to another issue. Do not edit root files unless your issue requires it.

## 6. Facts and wording

- State only facts you verified. Mark anything not built as not built.
- Do not guess dependency versions. Check them with `npm view <package> version`.
- Refer to Claude Code descriptively. Where the product is described, say that Orbitrace is not affiliated with Anthropic.
- Write plain, direct English. No marketing language.

What Orbitrace reads, stores and puts in a shared replay is in [docs/privacy.md](docs/privacy.md). Any change to what a shared replay contains must update that page in the same pull request.
