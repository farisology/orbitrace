# Fixtures

Synthetic Claude Code transcripts for tests and for the bundled demo. `manifest.json` and
everything under `config/` are written by the generator in `packages/fixtures`. Nothing
comes from a real session: the project names, prompts, replies, file names, commands and ids
are all invented, and every piece of free text starts with the word "Synthetic".

`replays/` is not written by the generator. It holds `minimal.replay.json`, the hand-written
synthetic example of the replay format (see `docs/replay-format.md`).

Do not edit the generated files by hand, and never put a real transcript here. To change a
fixture, change the generator and run:

```sh
npm run generate -w @orbitrace/fixtures
```

A test in `packages/fixtures` fails when `manifest.json` or `config/` differs from what the
generator writes.

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

`manifest.json` holds, for each session, the paths of its files and an `expected` block:
counts per agent (lines, replies, tool calls, failed and unfinished calls, MCP calls, usage
merged by maximum per reply) and the waves and idle gaps the scenario scripted. These are
facts about the raw transcripts, known from how they were written. They are not replay
models.

## Golden replay files

Not here yet. A golden replay file is the output of the replay model builder in
`@orbitrace/core` (issue #8, not built yet) for one of these sessions. They are added once
that builder exists, and are written by it, never by hand.
