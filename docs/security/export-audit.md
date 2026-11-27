# Privacy audit of the export path (issue #23)

**Status:** done on 27 Nov 2026, against `dev` at `5abeed0`. One finding was fixed in this
change (F1). The others are accepted with a reason or open as proposals. Orbitrace is not
affiliated with Anthropic; Claude Code is named only to describe the files Orbitrace reads.

The question: can anything from a transcript other than the allow-listed structure reach a
shared replay file? In particular text, paths, emails, secrets, ids or names that identify a
person, a project or a client.

## Scope

The whole path from a transcript line to the bytes someone shares:

| Step                       | Code                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Read lines                 | `packages/core/src/parser/lines.ts` (`readJsonLines`)                                   |
| Parse                      | `packages/core/src/parser/parse-session.ts`, `run.ts`, `tools.ts`, `values.ts`          |
| `ParsedSession` (contract) | `packages/core/src/model/parsed.ts`                                                     |
| Build                      | `packages/core/src/replay/build.ts`, `names.ts`, `timeline.ts`                          |
| `ReplayModel` (contract)   | `packages/core/src/model/replay.ts`, `packages/core/schema/replay-v1.schema.json`       |
| Export                     | `packages/core/src/export/export-replay.ts`, `project.ts`, `validate.ts`                |
| Host glue                  | `packages/core/src/host/session-replayer.ts` (`load`)                                   |
| Command line               | `packages/cli/src/cli.ts` (`runExport`), `output.ts`, `errors.ts`, `sessions.ts`        |
| App drop-a-file            | `packages/app/src/load-file.ts` (read only; it builds the same way and does not export) |

Out of scope: the live server and editor transport (they carry the same `ReplayModel`, not a
file), session lists (`orbitrace list`, the session picker; they show project names by design,
see [privacy.md](../privacy.md)), and the renderer.

Threat model: the person sharing a replay is the owner of the session and is not hostile. The
risk is that their own private content ends up in the file without them noticing. The reader of
the file is anyone. A transcript can hold anything, so every string in it is treated as
possibly private, including values that look like names.

## Method

1. **Trace.** Every field of the export was traced back to the transcript fields it is built
   from, with the control that limits it (table below).
2. **Attack with tests.** Invented marker strings, each holding the token `zqx`, were planted
   in the synthetic fixture sessions (`fixtures/config`, from the seeded generator) and in a
   seeded generator of hostile sessions. Markers: a prompt sentence, POSIX, macOS and Windows
   home-folder paths, an email at `example.com`, multi-line text, non-ASCII text, a 200-character
   value, control characters, JSON-breaking characters, a made-up key in the shape of an API key,
   and identifier-shaped names. Home paths and the key shape are assembled at run time, so the
   repository holds no string that looks like a real one. The test then searches the exported
   bytes for `zqx` in any letter case.
3. **Indirect channels.** Names that are free text in disguise, lengths and counts, timing
   precision, ordering, ids derived from real ids, the file name, error messages, stdout and
   stderr.
4. **Fix or file.** Leaks inside the audited code were fixed with a regression test. Anything
   that needs a change to format v1 or to the contract is described and filed as a proposal.

### Tests added

All run in the normal suite (`npm test`), with fixed seeds. The three core files took 4.4 s
together on the audit machine.

| File                                                            | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/export/privacy-audit.test.ts`               | On every scenario: replacing every content string (14 rounds, every marker in every position) gives the same bytes; adding a marker key to every object at every depth gives the same bytes; renaming every id consistently gives the same bytes; moving every timestamp by the same amount gives the same bytes. On every scenario except `demo` (same line shapes, as large as the rest together): each id, structure and name string replaced on its own by a free-text marker and by an identifier-shaped marker (5,142 runs), and each key outside free content renamed on its own (7,538 runs). A free-text marker never appears; an identifier-shaped marker appears only in a name field and only when planted in a name position. Also the app's drop-a-file path. |
| `packages/core/test/export/privacy-property.test.ts`            | 400 seeded hostile sessions (markers as values, keys, ids, tool names, MCP servers, agent types, models, effort, versions and line types; broken timestamps, negative and non-numeric token counts, dangling links, malformed lines, missing meta files). Every export is a valid replay; a marker appears only as an identifier name copied whole.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/core/test/export/privacy-errors.test.ts`              | A marker at every leaf of a replay, and as property names, never shows in `describeReplayProblems`, `assertReplay` or `exportReplay` errors, except the accepted case in F6. Option errors do not quote the value. The file name is fixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/cli/test/export-privacy.test.ts`                      | `orbitrace export` on a session whose project folder, session id, working directory, branch, title, text and subagent descriptions hold markers: no marker in the file, stdout, stderr or the `--json` document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/test/replay/names.test.ts`, `build.test.ts`      | Regression for F1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/core/test/export/audit-corpus.ts`, `audit-markers.ts` | Helpers: corpus loader, position walker, single-mutation runner, markers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Field table

"Can user text reach it" means: can a value that a person wrote or chose (prompt, file content,
path, configuration name) arrive in this field.

| Export field                                        | Built from                                                              | Can user text reach it                                                                                                                   | Control                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatVersion`                                     | constant                                                                | no                                                                                                                                       | schema `const: 1`                                                                                                                                                                                                                                                                |
| `agents[i].id`                                      | builder counter (`main`, `a1`, ...)                                     | no                                                                                                                                       | assigned, never copied; schema pattern `^(main\|a[1-9][0-9]{0,5})$`                                                                                                                                                                                                              |
| `agents[0].name`, `.callsign`                       | constant `main`                                                         | no                                                                                                                                       | schema `const`                                                                                                                                                                                                                                                                   |
| `agents[i].name` (subagent)                         | meta `agentType`                                                        | **yes, as a name**: agent types come from the user's agent definitions                                                                   | `agentNameOf`: kept only if it already matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, else `subagent` (F1); schema pattern                                                                                                                                                        |
| `agents[i].callsign`                                | `name` plus `#n`                                                        | same as `name`                                                                                                                           | `assignCallsigns`; schema pattern                                                                                                                                                                                                                                                |
| `agents[i].model`                                   | most frequent `message.model` of the agent's replies, else meta `model` | **yes, as a name** when a custom model id is configured                                                                                  | `modelIdOf`: kept only if `^[a-z0-9][a-z0-9._-]{0,63}$`, else `null`; schema pattern                                                                                                                                                                                             |
| `agents[i].family`                                  | word after `claude-` in `model`                                         | only a part of `model`                                                                                                                   | `familyOf`: `[a-z][a-z0-9]*`, at most 32; else `unknown`; schema pattern                                                                                                                                                                                                         |
| `agents[i].effort`                                  | assistant line `effort`                                                 | no                                                                                                                                       | closed set; anything else `null`; schema `enum`                                                                                                                                                                                                                                  |
| `agents[i].parent`                                  | link through meta `toolUseId` and `tool_use.id`                         | no                                                                                                                                       | ids are only compared, the builder writes its own id                                                                                                                                                                                                                             |
| `agents[i].wave`                                    | computed from compressed starts                                         | no                                                                                                                                       | integer                                                                                                                                                                                                                                                                          |
| `agents[i].start`, `.end`                           | line timestamps                                                         | no text; timing (F4)                                                                                                                     | seconds from the first visible line, compressed; number `>= 0`                                                                                                                                                                                                                   |
| `tools[j].name`                                     | `tool_use.name`; for MCP only the server part                           | **yes, as a name**: MCP server names come from the user's configuration; a non-built-in tool name can be one the model invented (F2, F3) | `toolLabelOf`: MCP gives `mcp:<server>` with the server kept only if `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (else `mcp:unknown`); the MCP tool part is dropped; other names kept only if `^[A-Za-z][A-Za-z0-9_]{0,63}$` (else `unknown`) (F1); schema pattern, raw `mcp__` rejected |
| `tools[j].kind`                                     | parser classification of the name                                       | no                                                                                                                                       | closed set; schema `enum` and `if/then`                                                                                                                                                                                                                                          |
| `tools[j].start`, `.end`                            | timestamps of the `tool_use` and `tool_result` lines                    | no text; timing (F4)                                                                                                                     | as `start`                                                                                                                                                                                                                                                                       |
| `tools[j].failed`                                   | `tool_result.is_error === true`                                         | no                                                                                                                                       | boolean                                                                                                                                                                                                                                                                          |
| `replies[k].t`                                      | timestamp of the reply's first line                                     | no text; timing (F4)                                                                                                                     | as `start`                                                                                                                                                                                                                                                                       |
| `replies[k].*Tokens`                                | `message.usage` (maximum across the reply's lines)                      | no text; sizes (F4)                                                                                                                      | finite and `>= 0`, else 0; floored; schema integer `>= 0`                                                                                                                                                                                                                        |
| `agents[i].totals`, `totals`                        | sums and counts                                                         | no text; counts (F4)                                                                                                                     | integers                                                                                                                                                                                                                                                                         |
| `warps[]`, `totals.duration`, `totals.realDuration` | idle cuts                                                               | no text; real idle lengths (F4)                                                                                                          | numbers                                                                                                                                                                                                                                                                          |

Read for linking only, never written: the session id, line `uuid`, `message.id`, `tool_use.id`,
`tool_result.tool_use_id`, meta `toolUseId`, the runtime agent id from the file name. Read and
kept in `ParsedSession` but not exported: Claude Code versions, unknown line types and their
counts. Never read: message text, thinking, tool inputs, tool results, `cwd`, `gitBranch`,
title and last-prompt lines, file-history snapshots, meta `description`, `entrypoint`, every
other key.

Defence in depth after the builder: `exportReplay` rebuilds the value from an allow-list
(`projectReplay`, own properties only, a fixed key order) and checks it against the schema
before it writes anything; the schema rejects every unlisted property and limits every string
to an identifier pattern.

## Findings

| Id  | Severity | Status                       | Title                                                               |
| --- | -------- | ---------------------------- | ------------------------------------------------------------------- |
| F1  | Medium   | Fixed                        | Name clean-up kept the words of free text                           |
| F2  | Medium   | Mitigated, opt-in (#122)     | Identifier-shaped names are exported as written                     |
| F3  | Low      | Mitigated, opt-in (#122)     | Non-built-in tool names can be model output                         |
| F4  | Low      | Accepted, opt-in (#123)      | Timing and counts show the shape of the work                        |
| F5  | Info     | Accepted                     | Order of simultaneous unlinked subagents follows runtime id order   |
| F6  | Low      | Accepted                     | Validation names an extra property when it looks like an identifier |
| F7  | Low      | Accepted, docs request filed | `export --json` adds a session key and typed paths                  |
| F8  | Info     | Accepted                     | A live build copies names from the previous snapshot                |

### F1. Name clean-up kept the words of free text (Medium, fixed)

`agentNameOf`, `toolLabelOf` and the MCP server label in `packages/core/src/replay/names.ts`
replaced each run of characters outside the schema pattern with `-` or `_` and cut the result
to 64 characters. The value then passed the schema, with its words intact. `my client plan`
became `my-client-plan`; a path became its folder names joined by `-` (a home folder path gave
the user name); an email gave its local part and domain without `@`; a sentence gave its first
64 characters of words. The schema check after export could not see it: the result was a valid
identifier.

Evidence: with the old `names.ts`, the single-position test reported 109 leaking positions in
the corpus (12 meta `agentType` positions leaking into `name` and `callsign`, 97 `tool_use.name`
positions leaking into `tools[].name`), and the property test failed on most seeds.

Fix: a value is kept only when it already matches the pattern; anything else becomes the fixed
fallback (`subagent`, `unknown`, `mcp:unknown`), so no part of it is kept. Names that already
match the pattern, such as the built-in tool names and every agent type and MCP server in the
fixtures, are unchanged: every golden replay is byte for byte the same
(`npm run goldens:check -w @orbitrace/fixtures`: "golden replays match the pipeline"). Regression tests: `names.test.ts`, `build.test.ts`, and the audit tests above.

### F2. Identifier-shaped names are exported as written (Medium, mitigated by an opt-in option)

Agent types, MCP server names, tool names and model ids that already match the identifier
pattern are copied as they are, up to 64 characters, with `.`, `:`, `-` and `_` allowed. These
names are chosen by the user (agent definitions, MCP configuration, a custom model id), so they
can name a client or a project (`acme-billing-review`, `mcp:acme-jira`) or, if pasted there by
mistake, hold a secret shaped like an identifier. Evidence: the "names exported as written"
tests plant `zqx-client-rollout` and a made-up API-key-shaped value and find them in `name`,
`callsign`, `tools[].name` and `model`.

Already in place: [privacy.md](../privacy.md) says so under "Not guaranteed" and "Check before
you share", and `orbitrace export -o` prints a note to check agent type and MCP server names.

Not changed in this audit, because it changes what a replay says and needs a contract change.
Proposal (fits format v1, no schema change): an export option,
`ExportOptions.names: "as-written" | "opaque"`, filed as #122.

**Status (#122): mitigated by an opt-in option.** `ExportOptions.names: "opaque"`
(`packages/core/src/export/opaque-names.ts`) and `orbitrace export --opaque-names` now exist. With
it, every subagent's agent type becomes `agent-1`, `agent-2`, ... (callsigns keep their `#n`),
every MCP server `mcp:server-1`, ..., every tool name outside `OPAQUE_KEPT_TOOL_NAMES` `tool_1`,
... (an underscore, not the proposal's `-`, because the schema's tool name pattern allows no
`-`), and every model id that is not a known Claude model id `null`. The family is kept only when
it is one of `KNOWN_MODEL_FAMILIES` and becomes `unknown` otherwise, which is stricter than the
proposal: a family word outside that list is cut from a custom model id (`claude-<word>-...`) and
would carry it. Labels are counters in order of first appearance within one export, never a hash
of the name, and no mapping is written. The result still passes the unchanged v1 schema.

The owner decided the option is opt-in (decision on #122): the default export is unchanged, byte
for byte, so `--keep-names` was not added and F2 still applies to an export made without the
option. [privacy.md](../privacy.md#export-options-opt-in) and [cli.md](../cli.md#orbitrace-export)
say what the option hides and what it does not (how many distinct names there are, which agents
and calls share one, built-in tool names, known model ids).

Evidence, in `packages/core/test/export/export-options.test.ts`: with no option, every golden
replay is written byte for byte; with the option, on every fixture session, none of the
session's own identifier-shaped names appears anywhere in the serialised text, and invented
identifier-shaped markers (including `zqx-client-rollout` and the made-up API-key-shaped value)
planted in every name position, all at once and one position at a time, never appear. Unit tests
are in `opaque-names.test.ts`; the command line is tested in `packages/cli/test/export-options.test.ts`.

### F3. Non-built-in tool names can be model output (Low, open)

MCP tools are written as `mcp__<server>__<tool>` and built-in tools by their names. A non-MCP
name that is not a built-in can come from a tool the model asked for that does not exist; that
name is then model output, and if it is an identifier it is exported. Such names are expected
to be rare and short; this was not measured, because real transcripts are not read. A fix is a list of known built-in names with every other non-MCP name labelled
`unknown`; that is a product choice (new built-in tools would show as `unknown` until the list is
updated), so it is part of the F2 proposal rather than changed here.

**Status (#122): mitigated by the same opt-in option.** With `names: "opaque"`, a non-MCP name
outside `OPAQUE_KEPT_TOOL_NAMES` is written as `tool_<n>` (a counter, not `unknown`, so calls of
the same tool still share a label). Without the option it is exported as written.

### F4. Timing and counts show the shape of the work (Low, accepted)

Times are relative to the first visible line and cut idle gaps are recorded, so no wall-clock
time or date is exported (proved: moving every timestamp by the same amount gives the same
bytes). But the file keeps millisecond-precision durations of every call and reply, the real
length of each cut gap (`warps[].skipped`), the real session length (`realDuration`), and exact
token counts per reply. Token counts tell how large a prompt, a file read or a reply was; the
number and timing of calls can help someone who already holds a copy of the transcript to
recognise the session. This is the purpose of a replay and is listed under "Contains" in
privacy.md. Proposal (fits v1): an export option to round times (for example to 0.1 s) and
bucket token counts. Low priority; filed with F2 as #123.

**Status (#123): opt-in options exist; still accepted by default.** `ExportOptions.roundTimes`
(`orbitrace export --round-times <seconds>`) rounds every time, cut gap and duration to a step;
`ExportOptions.bucketTokens` (`--bucket-tokens`) writes reply token counts as the nearest of 1, 2,
5, 10, ... and totals as their sums (`packages/core/src/export/coarsen.ts`). The default export
keeps exact times and counts, and neither option hides the number, order or rough size of calls
and replies.

### F5. Order of simultaneous unlinked subagents follows runtime id order (Info, accepted)

Subagents with no link to a parent call are numbered by start time, then by input order, and
the Claude Code adapter lists subagent files by name. When two unlinked subagents start in the
same millisecond, their order follows the alphabetical order of their random runtime ids. No
part of an id is copied (proved: renaming every id gives the same bytes); this only reveals
which of two random ids sorts first.

### F6. Validation names an extra property when it looks like an identifier (Low, accepted)

`describeReplayProblems` names an extra property when its name matches
`^[A-Za-z_$][A-Za-z0-9_$]{0,31}$`, and says "(name not shown)" otherwise. A free-text name, a
path or an email is never shown (tested). An identifier-shaped name, such as a made-up key of
up to 32 characters, is shown. This happens only when someone validates a replay-shaped value
they already hold (a dropped file); export never reports extra properties, because it drops
them before the check, and the builder never adds any. Kept, because the name helps a person
fix a hand-edited file.

### F7. `export --json` adds a session key and typed paths (Low, accepted)

The replay file (`-o`) and plain stdout hold only the replay (tested). The `--json` document is
for scripts and adds `key` and `warnings`. The key is the first 32 hex digits of a SHA-256 of
the config folder, the project folder name and the session id. It cannot be reversed, but it is
not salted, so someone with the same transcripts can compute it and link a shared document to a
session. `warnings` repeats a `--config-dir` value exactly as typed when that folder is missing,
which can be a home-folder path. Neither is in the replay. Request: one sentence in
[cli.md](../cli.md) saying to share the replay file or `replay` value, not the `--json` document.

### F8. A live build copies names from the previous snapshot (Info, accepted)

With `BuildReplayOptions.previous`, `buildReplay` keeps the previous snapshot's `name`,
`callsign`, `model`, `family` and `effort` for agents it already showed, without checking them
again. Callers pass the snapshot they built themselves. Export checks the schema again before
writing, so a bad value would be refused, not written. No leak path found.

### Checked, no finding

- Content: no content string changes a single byte of the export.
- Unknown keys at any depth, in lines and meta files, are ignored.
- Ids are never copied; agent ids are assigned by the builder.
- Free text never reaches any field, from any position, in any form.
- `effort` and `kind` are closed sets; `family` is derived from an already accepted model id.
- The suggested file name is always `orbitrace.replay.json`, also for the app's Export button
  and the editor's save dialog (#168; checked on `dev` at e78bb38). The command line shows only
  the path the user typed, and `orbitrace export -o` prints only that path, the byte count and the
  share note.
- Error messages of export, validation, the session replayer and the command line are fixed
  text or a JSON pointer plus a rule; none quotes a value.
- Core writes nothing to stdout, stderr or a log (`console` is not used in `packages/core/src`).
- The app's drop-a-file path builds the same way and gives the same result.

## What is guaranteed

For a replay built by `buildReplay` and written by `exportReplay`, tested as above:

- No message text, thinking, tool input or output, path, command line, working directory,
  branch, title, subagent description, email or free-text value from the transcript, in whole or
  in part.
- No runtime id (session id, agent id, tool use id, line or message id) and nothing derived
  from one.
- No wall-clock time or date.
- No property outside the replay v1 schema, at any depth; every string matches an identifier
  pattern.
- The same input gives the same bytes; the file name holds no session or project name.

## What is not guaranteed

- **Agent type names, MCP server names, tool names and model ids are exported as written when
  they are already identifiers** (F2, F3), unless the export uses the opt-in `names: "opaque"`
  (`--opaque-names`). A name you chose after a client or a project, or a secret placed in a name,
  is otherwise in the file. Look at the names before you share a replay.
- Timing and size information is exported (F4), coarsened only with the opt-in `roundTimes` and
  `bucketTokens` options.
- The guarantees cover the export file. They do not cover the `--json` document of the command
  (F7), session lists, or a replay file someone edited by hand.
- The tests attack the code with invented data in the transcript shapes known today. Claude
  Code's format is internal and can change; a new field is ignored unless the parser is changed
  to read it, and any such change must be audited the same way.
