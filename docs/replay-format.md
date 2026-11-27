# Replay format v1

A replay is the structure of one agent session: which agents ran, when, on which model, which
tools they called, and how many tokens each reply used. It is what the renderer draws and what
export writes to a `.replay.json` file.

A replay is meant to be safe to share. It holds structure and timing only.

- TypeScript types: `packages/core/src/model/replay.ts` (exported from `@orbitrace/core`).
- JSON Schema (draft 2020-12): `packages/core/schema/replay-v1.schema.json` (exported as
  `@orbitrace/core/schema/replay-v1.schema.json`).
- Hand-written example: `fixtures/replays/minimal.replay.json`, synthetic.
- Generated examples: `fixtures/replays/<scenario>.replay.json`, one golden replay per synthetic
  fixture session, written by the real pipeline (the Claude Code adapter, `parseSession`,
  `buildReplay`, `validateReplay`, `exportReplay`). `demo.replay.json` is the demo the app and
  the editor extension show when there is no session. Goldens are never edited by hand; after a
  change to the parser, the builder, the export or the generator, rewrite them with
  `npm run build && npm run goldens -w @orbitrace/fixtures` and review the diff.

Status: built. `buildReplay` (#8) produces replays, `exportReplay` (#18) writes them, and
`validateReplay` checks them. `orbitrace export` writes a replay file from the command line, and
the app and the editor extension draw replays. Nothing is published yet.

## What a replay never contains

There is no field for any of these, and the schema rejects any property it does not list
(`additionalProperties: false` on every object):

- message text or thinking;
- tool inputs or tool outputs;
- file paths or command lines;
- the working directory or the git branch;
- the session title, the session id or any runtime id (agent id, tool use id, line uuid);
- subagent descriptions;
- wall-clock timestamps.

String fields are limited by schema patterns to identifiers without spaces (agent type names,
model ids, tool names), so free text cannot be stored in them either. Agent ids are assigned by
the replay builder (`main`, `a1`, `a2`, ...), never copied from the runtime.

Two tests guard this. `packages/core/test/replay-types.test.ts` fails to type-check if any
replay type declares a key from `FORBIDDEN_REPLAY_KEYS`. `packages/core/test/replay-schema.test.ts`
checks that every object schema sets `additionalProperties: false` and that an extra `text`
field, or any forbidden key, makes validation fail.

## Time

Every time value is a number of seconds from the session start on the compressed timeline,
that is, after idle gaps were cut. Decimals are allowed.

Idle gaps are cut by the replay builder. The rule taken from the prototype: build busy intervals
from subagent lifetimes, tool call spans and a few seconds around each reply; merge them; cut any
gap longer than 45 s down to 8 s; record each cut as a warp. These are the defaults in
`REPLAY_BUILD_DEFAULTS` (`idleGapSeconds`, `idleKeepSeconds`). The padding around each reply
(`replyPaddingSeconds`) defaults to 3 s, exported as `DEFAULT_REPLY_PADDING_SECONDS`;
`REPLAY_BUILD_DEFAULTS_RESOLVED` holds every default together.

To turn a compressed time `t` into real seconds from the session start, add `skipped` of every
warp whose `at` is less than `t`. `toRealSeconds(warps, t)` from `@orbitrace/core` does this.

## Shape

```text
ReplayModel
  formatVersion   1
  agents          [main agent, ...subagents in id order]
  warps           [{ at, skipped }] in `at` order
  totals          session totals
```

### Agent

| Field      | Type                                              | Notes                                                           |
| ---------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `id`       | `"main"` or `a<n>`                                | Assigned by the builder. See [Agent ids](#agent-ids).           |
| `name`     | string                                            | Agent type, such as `code-reviewer`. `main` for the main agent. |
| `callsign` | string                                            | `name`, plus `#n` when the name appears more than once.         |
| `model`    | string or `null`                                  | Model id, such as `claude-opus-5-5`.                            |
| `family`   | lower-case identifier                             | Open set. See [Model family](#model-family).                    |
| `effort`   | `low`, `medium`, `high`, `xhigh`, `max` or `null` | Any other raw value becomes `null`.                             |
| `parent`   | agent id or `null`                                | `null` only for the main agent.                                 |
| `wave`     | integer from 0, or `null`                         | `null` only for the main agent.                                 |
| `start`    | seconds                                           |                                                                 |
| `end`      | seconds or `null`                                 | `null` while the agent is still running. See [End](#end).       |
| `tools`    | tool calls                                        | In start order.                                                 |
| `replies`  | replies                                           | In time order.                                                  |
| `totals`   | agent totals                                      | Sums over `tools` and `replies`.                                |

The main agent is always `agents[0]`. The schema enforces this with `prefixItems`.

#### Agent ids

`main` for the main agent. Subagents are `a1`, `a2`, ... and `agents` lists them in id order.

- Fresh build: subagents linked to a parent `Agent` call are numbered in the order of that call
  (call start time, then `tool_use` block order within one reply). Subagents with no link follow,
  in `ParsedSession.subagents` order.
- Live build (`BuildReplayOptions.previous` given): agents from the previous snapshot keep their
  ids; new subagents get the next free numbers, ordered among themselves by the same rule.

Callsigns number repeated names (`#1`, `#2`, ...) in id order, so they are stable too.

#### End

A subagent's `end` is `null` while it runs and then becomes a number; it does not go back. The
main agent's `end` is `null` while anything in the session is open at the snapshot time (one of
its own calls, a subagent, or lines after `now`) and otherwise the time of its last line. In a
live view the main agent often closes every call and later starts a new one, so its `end` may
switch from a number back to `null` between snapshots. A number on the main agent means "idle at
this snapshot", not "finished".

#### Waves

Walk subagents in id order. `a1` is in wave 0. Each next subagent opens a new wave (current wave
plus 1) when it starts more than 60 s (`waveGapSeconds`) after the latest start among subagents with
smaller ids; otherwise it joins the current wave. A wave depends only on agents with smaller ids,
so appending an agent never changes an existing wave. When id order matches start order, which is
the usual case, this equals the prototype's rule: sort by start, new wave after a gap.

Waves compare the compressed `start` values written in the replay, not wall-clock times. The
default idle cut (gaps over 45 s become 8 s) is below the default wave gap (60 s), so two
subagents with a long idle stretch between them can still be in the same wave.

#### Model family

`family` is an open identifier: a string matching `^[a-z][a-z0-9-]{0,31}$`. The builder writes the
family word as derived from the model id, whether or not the renderer knows it. For Claude Code it
is the word after `claude-` (`claude-opus-5-5` gives `opus`). A parser for another runtime defines
its own derivation. `unknown` is written only when the model is `null` or no word can be derived.

The renderer has shapes for `KNOWN_MODEL_FAMILIES`: `fable`, `opus`, `sonnet`, `haiku` and
`unknown`. It draws any other value as `unknown` (a circle). A new model family or another
runtime's models therefore need no new format version, and the real family stays in the file.

`effort` stays a closed set: a raw value outside it becomes `null`.

### Tool call

| Field    | Type              | Notes                                                            |
| -------- | ----------------- | ---------------------------------------------------------------- |
| `name`   | string            | Built-in name such as `Bash`, or `mcp:<server>` for an MCP tool. |
| `start`  | seconds           |                                                                  |
| `end`    | seconds or `null` | `null` when no result was seen.                                  |
| `failed` | boolean           | `true` when the result had `is_error`.                           |

MCP tools are named `mcp__<server>__<tool>` in transcripts. A replay keeps only the server, as
`mcp:<server>`; the schema rejects the raw `mcp__` form.

### Reply

One model reply, merged from every transcript line that shares a message id.

| Field                 | Type    | Notes                                |
| --------------------- | ------- | ------------------------------------ |
| `t`                   | seconds | Time of the first line of the reply. |
| `inputTokens`         | integer |                                      |
| `outputTokens`        | integer |                                      |
| `cacheReadTokens`     | integer |                                      |
| `cacheCreationTokens` | integer |                                      |

### Warp

| Field     | Type           | Notes                                  |
| --------- | -------------- | -------------------------------------- |
| `at`      | seconds        | Compressed time at which the cut sits. |
| `skipped` | number above 0 | Real seconds removed at this point.    |

### Totals

Agent totals: `toolCalls`, `failedToolCalls`, `replies`, `inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens`.

Session totals: the same fields summed over all agents, plus `agents` (number of agents),
`duration` (length of the compressed timeline) and `realDuration` (`duration` plus every warp's
`skipped`).

## Rules the schema cannot express

A replay builder must also keep these. The example fixture's test checks them, and the builder's
tests check them on every replay they build (`packages/core/test/replay/helpers.ts`).

- Each agent's `totals` equal the sums over its `tools` and `replies`.
- Session `totals` equal the sums over all agents; `agents` equals the number of agents.
- `realDuration` equals `duration` plus the sum of warp `skipped` values.
- Every subagent's `parent` is the id of an agent in the same replay.
- Subagents are in id order (`a1`, `a2`, ... with no gaps); each agent's tool calls are in start
  order.
- A tool call's `end`, when not `null`, is not before its `start`.
- Callsigns are unique.

## Append stability (live view)

Live view builds a new snapshot of one session on every change, with an increasing `now`, and
passes the snapshot it built before as `BuildReplayOptions.previous`. Between two such snapshots
the builder guarantees:

1. Every agent in the earlier snapshot is in the later one with the same `id`, `callsign`,
   `parent` and `wave`, at the same index in `agents`.
2. New subagents get the next free ids and are appended. A subagent transcript found one poll
   late is appended; it never shifts the ids, callsigns or waves of agents already shown.
3. An existing `tools` or `replies` entry changes only to fill in `end` or `failed`, or, for a
   reply, to raise token counts while its lines are still arriving. New entries are only
   appended.
4. Existing warps never move and none is added before them. Only the last warp's `skipped` may
   grow; new warps are appended. A time that falls inside a gap an earlier snapshot already cut is
   placed at that warp's `at`.

Values that only grow or fill in may change: a subagent's `end` (from `null`), `model`, `family`
and `effort` (from `null` or `unknown`), totals, `duration` and `realDuration`. The main agent's
`end` may also go back to `null` (see [End](#end)).

A renderer can therefore keep the selection and per-agent animation state keyed by agent id:
`OrreryHandle.updateModel` does that, while `setModel` loads a different replay. If the session no
longer contains what `previous` describes (for example the transcript was replaced), the builder
makes a fresh build and the guarantees do not hold for that one step.

A fresh build of a finished session can number subagents differently from a live chain of the
same session, when subagent transcripts were found out of order. Both are valid.

## Versioning

`formatVersion` is `1`. Because every object rejects unknown properties, any change to the shape,
including an added field, is a new format version with a new schema file. A reader must reject a
replay whose `formatVersion` it does not know.

Open string fields (`family`, agent `name`, `model`, tool `name`) take new values without a new
version. A reader must handle values it does not know: draw an unknown `family` as `unknown`, and
use names only as labels.

## Validating with Ajv

`validateReplay`, `describeReplayProblems`, `assertReplay` and `exportReplay` use a validator
precompiled from the schema (`packages/core/src/export/replay-v1-validator.generated.ts`), so
they need no Ajv at run time. A reader in another language can validate against the schema file
with any draft 2020-12 validator.

The schema test validates with Ajv 8 (`ajv/dist/2020.js`, class `Ajv2020`) with `strict: true`,
`allowUnionTypes: true` and `strictTuples: false`. `strictTuples` is off because `agents` is an
open tuple on purpose: `prefixItems` fixes the main agent first and `items` allows any number of
subagents after it.
