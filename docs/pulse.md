# Pulse: activity across sessions

Pulse (#27) sums up when your agents work and what they do, across many sessions: an
hour-of-week grid, the tool mix, a session timeline and idle time. This first part is the numbers:
`pulseReport` in `@orbitrace/core` (browser-safe) and the `orbitrace pulse` command
([cli.md](cli.md#orbitrace-pulse)). Charts in the app come in a later ticket and will call the
same function. Orbitrace is an independent project and is not affiliated with Anthropic.

**Nothing leaves your machine.** Pulse reads the sessions on your computer, computes the numbers
in memory and prints them. It sends nothing anywhere, writes no file and creates no folder or
store.

## What goes in

A list of sessions, each a replay (the structure-only model the orrery draws, see
[replay-format.md](replay-format.md)) with its session summary (`key`, `lastActivity`, `live`)
and, when the caller knows it, its real start (`startedAt`), and three options: a time zone (an IANA name such as `Europe/London`; default `UTC`) and an
optional range, `since` and `until`, in epoch milliseconds.

`orbitrace pulse` builds that list the way `list` and `export` find sessions: the same folders,
the same session listing, and sessions that only the history store holds when a store exists
(see [cli.md](cli.md#orbitrace-history)). It builds each replay with the same steps as the
session replayer (open, parse, build, replay format check, with the same error codes) and passes
the parsed session's first timestamp as `startedAt`.

## What each number means

All lengths are whole milliseconds. Replay times are seconds on a 1 ms grid, so each is turned
into an integer once and every sum after that is exact: the grid's cells add up to the totals,
and the kinds and names of the tool mix add up to the total number of calls.

### When a session happened

A replay holds no clock time: its times are seconds from the session start, with long idle
stretches cut out (the `warps`). Its real length is `totals.realDuration`. Pulse places a session
on the calendar from its **real start**, `startedAt`: the earliest first timestamp of its
transcripts (the main one and every subagent's), which is the instant the replay's time 0 stands
for. The session **starts** there and **ends** its real length later. The timeline entry says
`anchor: "start"`. `orbitrace pulse` always passes it, so every figure (the hour-of-week grid,
the timeline and the `--since` / `--until` test) follows the timestamps inside the transcripts,
not file times: a copy that did not keep file times, a git clone, a restore from a backup, or a
running session whose live registry entry keeps moving changes nothing.

A caller that does not pass `startedAt` (or a session with no timestamp at all) gets a fallback:
the session **ends** at its **last activity** (the newest write to its transcripts, or the live
registry's update time if later) and starts its real length before that. The entry then says
`anchor: "last-activity"`. That anchor is off whenever a file's modification time changed for
another reason, which is why the command does not use it when a timestamp exists.

### Active and idle

The replay builder finds the stretches in which nothing was in progress: no reply line (counting
3 seconds before and after each reply), no tool call between its call and its result, and no
running subagent. A stretch longer than the idle gap (45 s) is cut down to 8 s.

- **Idle** is the real time that was cut: the sum of `warps[].skipped`. One idle gap is one warp.
- **Active** is the rest of the real length: the length of the compressed timeline
  (`totals.duration`). It includes every pause shorter than 45 s and the 8 s kept of each longer
  one.
- Active plus idle is always the real length of the session.
- **Time that runs at the same time.** Within a session, time when several agents or tool calls
  run at once counts once: active time is the length of the session's one compressed timeline
  (the union of its busy stretches), not a sum per agent or per call. Across sessions, time is
  per session and adds up: sessions that overlap each count their own time, so an hour cell or a
  total can exceed the wall-clock time it covers (two sessions active over the same 40 minutes
  give 80 minutes). Pulse has no wall-clock union figure.

### Waiting on the user: not known

A replay records no user prompts. So Pulse cannot tell how much of the idle time was spent
waiting for you:

- an idle stretch can be you reading, typing or away, but also the model's time before the first
  line of its next reply (that time is not inside a reply or a tool call);
- a tool call waiting for your permission is an open call, so that wait counts as **active**, not
  idle.

Pulse reports idle time under that neutral name, and `idle.waitingOnUser` is `{ "known": false }`.
Telling the two apart needs the times of the user's prompts in the model, which it does not have
today.

### Hour-of-week grid

Seven rows, Monday to Sunday (ISO 8601 order), of 24 hours, in the stated time zone. A week
starts on Monday at 00:00 local time. Each cell has:

- `activeMs` and `idleMs`: the active and idle time that fell in that local hour. A stretch that
  crosses an hour boundary is split at it. Within a session, time when several agents or tool
  calls run at once counts once; sessions that overlap each add their own time, so a cell can
  hold more than an hour (3,600,000 ms).
- `sessionsStarted`: sessions whose start fell in that hour.
- `keys`: the sessions with any of the three in that hour.

Time zones are handled with `Intl.DateTimeFormat` only: the offset at each instant comes from the
zone's rules, and the instant of each offset change is found exactly. On a spring-forward day the
local hour that does not exist gets nothing; on a fall-back day the local hour that happens twice
gets both real hours. Zones with half-hour offsets (such as `Asia/Kolkata`) have their hour
boundaries at half past the UTC hour. The tests cover London, New York, Tokyo, Kolkata and Lord
Howe Island (a half-hour daylight-saving change) with fixed instants.

### Tool mix

Every tool call of every agent, counted once, from the replay:

- `byKind`: calls per `kind` (`shell`, `read`, `edit`, `agent`, `mcp`, `other`, always in that
  order, zeros included);
- `byName`: calls per tool label as the replay holds it (`Bash`, `Read`, `mcp:<server>`; an MCP
  tool is reduced to its server name), most calls first;
- for each: `calls`, `failed` (the result had `is_error`), `open` (no result was seen: still
  running, or the result line is missing) and `keys`.

### Session timeline

One entry per session, oldest first: `key`, `start`, `end`, `spanMs` (real length), `activeMs`,
`idleMs`, `idleGaps`, `agents` (main agent and subagents), `toolCalls`, `failedToolCalls`,
`openToolCalls`, `replies`, `tokens` (input, output, cache read, cache creation, as in the
[ledger](ledger.md)), `live` and `anchor`.

### Totals, idle and links to sessions

`totals` sums the timeline. `idle` repeats the idle total and adds the number of gaps, the
longest gap and `waitingOnUser`. Every bucket and every total lists the session `keys` it came
from, in timeline order, so a chart can link each bar to its sessions.

### Range

A session is counted, whole, when its start is at or after `since` and before `until`. Its time
is still placed in the hours it really covered, even past `until`. Sessions left out by the range,
repeated keys and inputs that cannot be placed (a missing last activity, a negative length) are
counted in `skipped`, never thrown on.

## `orbitrace pulse`

Options and the `--json` shape are in [cli.md](cli.md#orbitrace-pulse). What it adds to the
report:

- **When.** Each session's real start is the first timestamp of its transcripts (above), so
  the range test and the grid follow the transcripts. The listing is not filtered by `--since`,
  because it filters on file times, which can be earlier than the transcripts say.
- **The limit.** Sessions are read newest first by last activity (the order the listing has
  without reading anything), and **at most `--limit` sessions are read** (default 100), whatever
  the outcome: counted, outside the range, or unreadable. So a run stays bounded even when most
  sessions are outside the range. `sessions.notReadLimit` says how many listed sessions were not
  read because of it; `read + unreadable.count` is never more than `limit`. With a narrow range
  far in the past, raise `--limit` so the older sessions are reached.
- **What could not be read.** `sessions.unreadable` counts sessions whose transcript could not be
  read or whose replay could not be built, by error code (`unreadable`, `invalid`, `internal`,
  `not-found`); the others are still counted. The text output gives the count and the codes, for
  example `2 could not be read (invalid 1, unreadable 1).`
- **Where they came from.** `sessions.fromHistory` counts the counted sessions read from the
  history store, and `sessions.historyKeys` lists their keys in timeline order, so any figure can
  be split by source. The text session table marks them `hist` in a SRC column, shown only when
  at least one session came from the history store.
- **Text in 80 columns.** The session table shows lengths compactly (`53m32s`, `1h02m`) and each
  key as the shortest start of its hash, at least 8 characters, that no other session under the
  folders starts with; `orbitrace open` and `export` accept it. The whole keys are in `--json`.
- **Versioning.** `version` covers the whole `pulse --json` document, the fields the command adds
  (`sessions`, `project`, `warnings`) included: a change to any of them bumps it.

How long it takes, measured on 28 Nov 2026 on one laptop with the built command and Node 26, on
1,000 sessions generated by the synthetic fixture generator (the nine scenarios in turn, 88 MB in
all, about 88 KB per session), each command run twice in a row (the second run shown; the first
was up to 0.6 s slower, as the laptop was busy):

| Run                                                 | Sessions read | Time   |
| --------------------------------------------------- | ------------- | ------ |
| `--limit 1`                                         | 1             | 1.3 s  |
| `--limit 50`                                        | 50            | 1.7 s  |
| default (`--limit 100`)                             | 100           | 1.9 s  |
| `--limit 200`                                       | 200           | 2.3 s  |
| `--limit 1000`                                      | 1,000         | 14.5 s |
| `--until 2026-01-01` (before every session)         | 100           | 1.1 s  |
| `orbitrace list --json` (all, for the listing cost) | 0             | 1.2 s  |

So about 13 ms per session read after start-up and listing. The default limit of 100 caps the
sessions read, in or out of the range, so a run stays near 2 s on sessions of that size even when
none of them is in the range. Real transcripts are often larger, and each one is parsed in full,
so a run grows with the size of the sessions read; lower `--limit` to keep it short.

## What is in the output, and what is not

In the output: session keys (hashes, which hold no path or project name), times and lengths,
counts, tool labels and MCP server names (as an export keeps them), token counts, the time zone
and the range. With `--json`, also `project` when `--project` was given, and any `--config-dir`
path as typed in a warning.

Not in the output: prompts, replies, thinking, tool inputs or outputs, file contents, command
lines, paths, working folders, project names (other than the `--project` you typed), session ids
or subagent descriptions. A test plants a marker string in every prompt, reply, tool input, tool
output, working folder and subagent description of a synthetic session and checks that it
appears nowhere in the text or JSON output.

## What is not known or not built

- Waiting on the user (above).
- The real start of a session when its transcripts hold no timestamp at all: then, and only
  then, the start comes from the last activity (`anchor: "last-activity"`), which follows file
  times.
- Which sessions are newest when file times were not kept: the reading order (and so which
  sessions a limit leaves out) comes from the listing's last activity, a file time. The figures
  of the sessions read do not depend on it.
- The wall-clock time covered by overlapping sessions: Pulse sums per session (above).
- Pauses inside a reply or a tool call are active time, however long.
- Charts: a later ticket draws these numbers in the app.
