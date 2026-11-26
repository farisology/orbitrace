# Instructions for coding agents

This file is for coding agents working in this repository. Humans should read it too: it is the detailed form of [CONTRIBUTING.md](CONTRIBUTING.md).

**Status: nothing is released yet.** The workspace scaffold is not in place, so some commands below do not run yet. Say so in your pull request when that happens.

## 1. Privacy rules (hard rules, public repository)

Anything you write into this repository becomes public. That includes code, tests, comments, documentation, examples, commit messages, issues and pull request text.

- Never write real transcript content: prompts, replies, file contents, tool inputs or outputs, or command lines.
- Never write paths from a user's machine, including a home folder path, or project names from a user's machine.
- Never write session ids, email addresses, tokens or secrets.
- Do not read files under the `projects` folder of the Claude Code config folder directly. If you need to learn the shape of a transcript, use a script that prints key names and value types only. Never print, copy or quote values.
- Do not copy code from other projects, including projects under permissive licences. Studying a technique is allowed.

Why: the repository is public, and the product exists to show agent sessions without exposing their content. A leak in the repository is a leak of the very data the product protects.

## 2. Synthetic fixtures

- Tests and demos use invented data only: invented agent types, file names, tool calls, prompts and timings.
- Transcript fixtures go under `fixtures/` or `test/fixtures/`. `.gitignore` allows `*.jsonl` files only in those folders and ignores every other `*.jsonl` file. Do not rely on that rule: check `git status` before each commit, and confirm that every fixture you add is synthetic.
- If you need an example of the transcript format, write one by hand with invented values.

## 3. Branch flow

1. Start from `dev`. Create a feature branch named for the change, for example `docs/4-contributor-docs`.
2. Commit on the feature branch only.
3. Open a pull request with `dev` as the base branch.
4. Never push to `main`. Never commit directly to `dev` or `main`. The owner merges `dev` into `main`.

## 4. Before you open a pull request

Run these from the repository root, in this order, and report the real output:

```sh
npm ci            # after dependency changes, or on a fresh clone
npm run build
npm run typecheck
npm run lint
npm test
npm run privacy
```

- If a command fails, fix the cause or report the failure in the pull request. Do not hide it.
- If a command does not exist yet, say so in the pull request.
- Check the privacy checklist in `.github/PULL_REQUEST_TEMPLATE.md` before you submit.

## 5. Keep changes inside one package

- Work inside one package where possible: `core`, `renderer`, `app`, `vscode` or `cli`.
- `core` has no editor dependency. It holds the parser, source resolution, the replay model builder and export.
- `renderer` is framework-free Canvas 2D code that takes a replay model.
- `app` is a React and Vite shell. It talks to its host through a transport interface.
- If a change must cross packages, explain why in the pull request description.
- Do not build features that belong to another issue. Stay inside the issue you were given.

## 6. Facts and claims

- State only what you verified, or what the design documents say.
- Mark anything that is not built as not built.
- Do not guess dependency versions. Check them with `npm view <package> version`.
- Refer to Claude Code descriptively. Where the product is described, say that Orbitrace is not affiliated with Anthropic.
- Write plain, direct English. Avoid marketing language.

## 7. Reference: where session data lives

Facts for reading the code. The transcript format is internal to Claude Code and can change in any release.

- Transcripts: `<config>/projects/<project>/<session-id>.jsonl`. The config folder is by default a `.claude` folder in the user's home directory. `CLAUDE_CONFIG_DIR` moves it.
- Subagent transcripts: `<config>/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`, with an `agent-<agentId>.meta.json` file beside each one.
- Each transcript line is one JSON object. The parser must skip and count line types it does not know.
- One model reply can be written as several lines that share a `message.id`. Merge them. Keeping only the first line undercounts tool calls by a large factor.
- When merging lines of one message, take the maximum of each usage field, not the sum.
- Retention: Claude Code removes transcripts after `cleanupPeriodDays`, which defaults to 30. It cannot be disabled.

See [docs/privacy.md](docs/privacy.md) for what Orbitrace reads, stores and shares.
