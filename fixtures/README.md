# Fixtures

Synthetic Claude Code transcripts for tests and for the bundled demo. `manifest.json` and
everything under `config/` are written by the generator in `packages/fixtures`. Nothing
comes from a real session: the project names, prompts, replies, file names, commands and ids
are all invented, and every piece of free text starts with the word "Synthetic".

`replays/` is not written by the generator. It holds one golden replay file per session,
written by the replay pipeline of `@orbitrace/core` from the transcripts in `config/` (see
[Golden replay files](#golden-replay-files)), and `minimal.replay.json`, the hand-written
synthetic example of the replay format (see `docs/replay-format.md`).

Do not edit the generated files or the golden replay files by hand, and never put a real
transcript here. To change a fixture, change the generator and run both commands, from the
repository root, after `npm run build`:

```sh
npm run generate -w @orbitrace/fixtures   # manifest.json and config/
npm run goldens -w @orbitrace/fixtures    # replays/<session>.replay.json
```

Tests in `packages/fixtures` fail when `manifest.json` or `config/` differs from what the
generator writes, and when a golden replay file differs from what the pipeline writes.

## Layout

```text
fixtures/
  manifest.json                     every session, its files and what is true of it
  config/                           laid out like a Claude Code config folder
    projects/
      <project>/
        <session-id>.jsonl          main transcript, one JSON object per line
        <session-id>/subagents/
          agent-<agentId>.jsonl     subagent transcript, same line format
          agent-<agentId>.meta.json subagent meta file
  replays/
    <session>.replay.json           golden replay of one session, named as in the table below
    demo.replay.json                golden replay of the demo session
    minimal.replay.json             hand-written example of the replay format
```

`<project>` is the invented working directory with every non-alphanumeric character
replaced by a dash, which is how Claude Code names project folders. Point a source resolver
at `fixtures/config` the way `CLAUDE_CONFIG_DIR` would.

## Sessions

| Name               | What it is for                                                                     |
| ------------------ | ---------------------------------------------------------------------------------- |
| `single-agent`     | One agent, two turns, no subagents, no reply split over lines                      |
| `two-waves`        | Three subagents started together, then two more over a minute later                |
| `tool-failures`    | Failed tool calls, calls with no result, a subagent that never finishes            |
| `idle-gap`         | A 47 minute and a 95 second idle gap, a 40 second pause, a 4 minute command        |
| `unknown-lines`    | Line types, a block type, a tool name and a model family that do not exist         |
| `split-reply`      | One reply over five lines whose usage only merges by maximum, a call written twice |
| `mcp-tools`        | MCP tool calls on three invented servers                                           |
| `nested-subagents` | A subagent that starts two subagents of its own                                    |
| `demo`             | The bundled demo: four waves, fourteen subagents, every model family and effort    |

`manifest.json` holds, for each session, the paths of its files, the path of its golden
replay file (`goldenReplay`; the top-level `goldenReplays` lists them all) and an `expected`
block: counts per agent (lines, replies, tool calls, failed and unfinished calls, MCP calls,
usage merged by maximum per reply) and the waves and idle gaps the scenario scripted. These
are facts about the raw transcripts, known from how they were written. They are not replay
models.

## Golden replay files

`replays/<session>.replay.json` is what the replay pipeline of `@orbitrace/core` makes of one
session: the Claude Code source adapter opens the session in `config/`, `parseSession` reads
it, `buildReplay` builds the replay, `validateReplay` checks it against the replay v1 schema
and `exportReplay` writes it, indented. No golden is written by hand.

A golden is a replay v1 file: structure and timing only. It holds no text, no path, no
project name and no session id, and its file name is the scenario's name.

`demo.replay.json` is the golden of the `demo` session. It is there for the demo the app
bundles (issue #11, not built yet): `@orbitrace/fixtures` exports its path as
`DEMO_GOLDEN_REPLAY_PATH`.

A test in `packages/fixtures` runs the pipeline again and fails when a golden differs,
naming each place that changed. When the change is intended (the parser, the builder, the
export or the generator changed on purpose), rewrite the goldens and commit them with the
change:

```sh
npm run build
npm run goldens -w @orbitrace/fixtures
```

Read the diff of the rewritten files before committing: it is the change in what Orbitrace
shows for these sessions.
