# 0001. Storage for the history index

Status: accepted, with the engine changed by the amendment at the end. Ticket: #24 (spike), amended for #25. Date: 2026-11-26, amended 2026-11-27.

This is a time-boxed spike. The code under `spikes/storage/` is a measurement harness, not production code. No package uses it, and the history index itself is not built yet.

## Context

Orbitrace reads the transcripts Claude Code writes. Claude Code deletes them after `cleanupPeriodDays` (default 30, cannot be disabled), so history that outlives that cleanup needs its own store, and searching it needs full-text search. The first release has no database: it reads transcripts directly. This record decides what the history index should use when it is built.

Constraints:

- It runs inside an editor extension host. A native Node module (a `.node` binary built per platform and per Electron ABI, such as `better-sqlite3`) has to be rebuilt or prebuilt for every editor and platform, so it is out of scope.
- VS Code, Cursor and Windsurf each ship their own Electron and Node. The choice must not depend on one editor version.
- The repository targets Node 20+.
- The store holds user content. It stays on the user's machine and out of git.

## Options

- (a) `node:sqlite`, the SQLite built into Node.
- (b) A WebAssembly build of SQLite with FTS5. Packages tested (versions from `npm view <pkg> version` on 2026-11-26):
  - `sql.js` 1.17.0 (MIT, 31.7 MB unpacked)
  - `node-sqlite3-wasm` 0.8.61 (MIT, 1.3 MB unpacked, bundles SQLite 3.54.1, one maintainer account, last publish activity 2026-10-16)
  - `@sqlite.org/sqlite-wasm` 3.54.1-build1 (Apache-2.0, 3.0 MB unpacked, declares `engines.node >=22`)
  - Looked up but not tested: `@journeyapps/wa-sqlite` 2.0.10 (needs a VFS and glue code to persist in Node), `sql.js-fts5` 1.4.0 (last modified 2022-05), and the npm package named `wa-sqlite` 1.0.0 (last modified 2024-01).
- (c) No database: a JSON lines file plus an in-memory inverted index built at startup.

## Runtime check

The VS Code installed on the test machine is 1.148.0 (macOS, from `Contents/Resources/app/package.json`). Its Node:

```
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" -e 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,sqlite:process.versions.sqlite,modules:process.versions.modules}))'
{"node":"24.22.1","electron":"43.8.10","sqlite":"3.53.4","modules":"148"}

ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" -e 'console.log(Object.keys(require("node:sqlite")))'
[ 'DatabaseSync', 'StatementSync', 'Session', 'constants', 'backup' ]
```

So `node:sqlite` exists in VS Code 1.148.0, with SQLite 3.53.4. Opening a database printed no `ExperimentalWarning` there or on Node 26.5.0.

Three runtimes were available and all were tested: system Node 26.5.0, VS Code 1.148.0's Node 24.22.1, and an older Node 19.8.1. On Node 19.8.1 `node:sqlite` does not exist (`No such built-in module: node:sqlite`). Node 20 and 22 were not run, so this record does not say which version first ships `node:sqlite`. Cursor and Windsurf are not installed on the test machine. Each editor's Node moves with its Electron version, so a fork or an older editor can lack `node:sqlite` even when current VS Code has it.

## FTS5 in each package

From `spikes/storage/`, `probe.mjs` creates an FTS5 table in memory and runs one `MATCH` query with each engine:

```
npm ci
node probe.mjs
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" probe.mjs
/usr/local/bin/node probe.mjs        # Node 19.8.1 on the test machine
```

| Engine                                  | Node 26.5.0            | VS Code (Node 24.22.1) | Node 19.8.1                       |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------------- |
| `node:sqlite`                           | FTS5 yes               | FTS5 yes               | module missing                    |
| `sql.js` 1.17.0                         | `no such module: fts5` | `no such module: fts5` | `no such module: fts5`            |
| `node-sqlite3-wasm` 0.8.61              | FTS5 yes               | FTS5 yes               | FTS5 yes                          |
| `@sqlite.org/sqlite-wasm` 3.54.1-build1 | FTS5 yes               | FTS5 yes               | FTS5 yes (despite `engines >=22`) |

`sql.js` drops out: no FTS5.

`@sqlite.org/sqlite-wasm` says in its README: "Node.js is currently only supported for in-memory databases without persistence." The benchmark builds the database in memory and writes the exported bytes to a file. Every start would need to load the whole file into memory, and every save would rewrite it. That is a poor fit for an index that grows a little at a time.

`node-sqlite3-wasm` writes a normal SQLite file through Node's `fs`.

## Method

All commands run from `spikes/storage/`. The data is synthetic. `generate.mjs` uses a seeded generator to build 50,000 messages across 500 invented sessions. Words come from made-up syllables, about 2,000 distinct terms. Three probe words are planted at known rates so every engine must return the same counts. The output is 20.9 MB of JSON lines and is the same on every runtime tested (SHA-256 `f7d3f502...a8b876` on Node 26.5.0, 24.22.1 and 19.8.1).

```
npm ci
node generate.mjs                    # data/messages.jsonl, 50,000 records
shasum -a 256 data/messages.jsonl    # f7d3f50285526a39a6609e94acd3bf0a53f4caaa4de8fbbe52bbebd4d1a8b876
sh ./run-all.sh                      # each option in its own process on system node, then a table
ELECTRON_RUN_AS_NODE=1 sh ./run-all.sh "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
sh ./run-all.sh /usr/local/bin/node  # any other node binary
node crosscheck.mjs                  # file compatibility and locking, after run-all.sh
```

Single option: `node bench.mjs <node-sqlite|node-sqlite3-wasm|sqlite-wasm|jsonl>` prints JSON.

What is measured:

- **Write**: open, create the tables, insert 50,000 rows in one transaction. The SQLite options use a `messages` table and an external-content FTS5 table, and each message is inserted into both. For `sqlite-wasm` this includes loading the module and exporting the bytes to a file. For `jsonl` it only writes the file. Building its index is shown separately as `index build`, because it runs again on every start.
- **File size** on disk after the write. For `node:sqlite` this is after a WAL checkpoint.
- **Query**: median of 20 runs after one warm-up, in ms, for two forms. `count` returns the number of matches. `top20` returns the first 20 hits by id with their session and timestamp. For SQLite, `top20` joins the FTS table to `messages`. For `jsonl`, it reads each hit's line back from the file by byte offset and parses it.
- **Memory**: process RSS at the end, minus the RSS after the input was loaded. RSS is noisy, so read it as a rough size only.
- **Correctness**: the summary prints the match count for each query and flags any mismatch between options. There was none in any run.

## Measurements

Machine: one macOS laptop with other work running, so timings vary between runs. Main runs: `run-all.sh` twice on Node 26.5.0 and twice on VS Code's Node 24.22.1. Ranges cover those four runs.

| Option                         | Write (ms)                     | File size | Start before first query    | RSS added (MB) |
| ------------------------------ | ------------------------------ | --------- | --------------------------- | -------------- |
| (a) `node:sqlite`              | 460 to 808                     | 27.1 MB   | open the file               | about 0 to 19  |
| (b1) `node-sqlite3-wasm`       | 772 to 1,684                   | 27.1 MB   | open the file               | 21 to 110      |
| (b2) `@sqlite.org/sqlite-wasm` | 960 to 1,675 (export 22 to 33) | 26.5 MB   | read whole file into memory | 133 to 177     |
| (c) JSON lines + index         | 44 to 76                       | 20.9 MB   | index build 441 to 776 ms   | 90 to 117      |

Node 19.8.1, one run: `node:sqlite` failed to load. Write times were 717 ms for (b1) and 918 ms for (b2). For (c), the write took 186 ms and the index build 525 ms.

Query times on VS Code's Node 24.22.1 (first run), median of 20, `count / top20` in ms:

| Query         | Matches | (a) node:sqlite | (b1) node-sqlite3-wasm | (b2) sqlite-wasm | (c) in-memory index |
| ------------- | ------- | --------------- | ---------------------- | ---------------- | ------------------- |
| rare term     | 51      | 0.015 / 0.044   | 0.261 / 0.288          | 0.054 / 0.304    | 0.001 / 0.037       |
| medium term   | 1,499   | 0.055 / 1.87    | 0.54 / 3.032           | 0.211 / 0.574    | 0 / 0.029           |
| common term   | 15,240  | 0.471 / 8.983   | 1.913 / 10.563         | 1.376 / 6.402    | 0 / 0.023           |
| two terms AND | 799     | 0.245 / 1.385   | 0.711 / 2.685          | 0.554 / 0.709    | 0.096 / 0.056       |
| phrase        | 512     | 0.236 / 0.863   | 0.848 / 1.6            | 0.509 / 0.691    | 0.179 / 0.214       |

The slowest query in the five reported runs (including Node 19.8.1) was `top20` on the common term with (b1): 18.994 ms on Node 26.5.0.

What the numbers show:

- Query speed does not separate the options. Every option answered every query on 50,000 messages in under 20 ms.
- (c) is fastest at query time because its index and all the message text stay in memory. A single-term `count` is just the length of an array. The cost moves to startup (about half a second per 50,000 messages, rebuilt on every start) and to memory (about 100 MB at this size). Both grow with history.
- Among the SQLite options, `node:sqlite` writes fastest and uses the least extra memory. (b1) writes 1.5 to 2 times slower, which is still under 2 seconds for 50,000 messages.
- SQLite with FTS5 makes a file about 30 percent larger than the raw JSON lines (27.1 MB against 20.9 MB). `node:sqlite` and (b1) produce files of the same size.

### File compatibility and locking

`crosscheck.mjs` output, which was the same on Node 26.5.0 and VS Code's Node 24.22.1:

```
wasm opens node:sqlite file as written (WAL mode): FAILED - unable to open database file
wasm opens node:sqlite file after journal_mode=DELETE: 799
node:sqlite opens wasm file: 799
wasm read with a leftover .lock directory: FAILED - database is locked
node:sqlite read with the same leftover .lock directory: 799
node:sqlite child write while node:sqlite holds EXCLUSIVE: Error: database is locked
wasm child write while node:sqlite holds EXCLUSIVE: wrote
integrity_check after the test: ok
```

What this shows:

- Both engines can read the same file format, but (b1) cannot open a WAL-mode file. With `journal_mode=DELETE`, each engine opened the other's file and returned the same count.
- (b1) locks a database by creating a `<file>.lock` directory next to it. Its file layer calls `fs.mkdirSync` to take the lock and `fs.rmdirSync` to release it. If that directory is left behind, (b1) refuses even to read: `database is locked`. Going by the source, a process killed while it holds a lock leaves the directory behind. The test simulated this by creating the directory; no process was actually killed.
- The two engines do not lock each other out. While one process held an `EXCLUSIVE` lock through `node:sqlite`, a second process wrote to the same file through (b1) and succeeded. A second `node:sqlite` process was refused, as expected. This run did not corrupt the file, but nothing stops two writers from different engines.

## What could not be tested

- Cursor and Windsurf (not installed), any VS Code other than 1.148.0, Windows and Linux.
- Node 20 and Node 22. Downloading those Node builds was not permitted in this session.
- A real extension host. The tests run the Electron binary as plain Node. Not checked: blocking the extension host thread (both SQLite options are synchronous, and a bulk write takes up to about 1.7 s), worker threads, and bundling the `.wasm` file with the extension.
- Crash recovery: killing a process mid-write, recovering a stale `.lock`, and two editor windows writing at once with the same engine.
- Incremental appends, deletes and vacuum. Only a bulk load of one size (50,000 messages) was measured.
- Real text. The synthetic vocabulary has about 2,000 terms. Real transcripts have far more, which makes every index bigger and makes (c) start slower. Tokenizer behaviour on code, paths and non-English text was not checked.
- What the index stores. Full message text and a structure-only summary give very different sizes. That is not decided here.

## Recommendation

Use SQLite with FTS5 through `node-sqlite3-wasm` (b1) as the only engine that writes the history index. Put it behind a small storage interface in `core`: open, append, search, close. Keep the file in `journal_mode=DELETE`.

Why:

- It is the only measured option that has FTS5, persists to a real file and loads on all three runtimes tested, including Node 19.8.1, where `node:sqlite` is missing. It needs no native build and does not depend on an editor's Node version.
- It opens instantly. (b2) has to load the whole database into memory, and (c) rebuilds its index on every start.
- FTS5 provides phrase and prefix queries and ranking, so we do not write our own tokenizer or index format.
- Its cost against `node:sqlite` is a slower bulk write (under 2 s for 50,000 messages) and more memory. Query times are in the same range.

Why not `node:sqlite` alone: it was the fastest and leanest option here, and VS Code 1.148.0 has it, but Node 19.8.1 does not. It was not checked on Node 20, Cursor or Windsurf. Because the file format is shared, switching to it later is a change of engine, not a data migration, once every supported runtime has it.

Why not both engines, chosen at run time: they do not lock each other out (measured above). If the extension used `node:sqlite` and the CLI on an older Node used (b1) on the same file, nothing would stop both writing at once.

Why not (c) as the index: its startup time and memory grow with history. It remains the right shape for the first release, which has no database, and it is the fallback if (b1) fails the checks below.

Main risk: the locking in `node-sqlite3-wasm`. A `.lock` directory left after a crash blocks reads and writes until someone removes it, and the package is pre-1.0 (0.8.61) with one maintainer account. Losing or locking the index does not touch the transcripts. But history older than the cleanup window cannot be rebuilt from them, because Claude Code has already deleted them. Before the history index ships, its ticket needs to:

1. Use one writer process with its own owner-checked lock (a pid file), so it can safely remove a stale `.lock`.
2. Kill a writer mid-transaction in a test, then check recovery.
3. Run writes off the extension host thread.
4. Test on Cursor, Windsurf, Windows and Linux.
5. Keep the storage interface narrow, so the engine can be replaced with `node:sqlite` or (c).

## Amendment (2026-11-27, ticket #25)

The lead decision on #25 changes the engine. The history store uses `node:sqlite` behind the narrow storage interface, found by feature detection, with no new runtime dependency. Where `node:sqlite` is missing, history reports itself unavailable with the reason and everything else works as before. The measurements above are kept as they were; this section records what changed and what #25 measured.

Reasons, from the lead decision on #25:

- No pre-1.0, single-maintainer package (`node-sqlite3-wasm` 0.8.61) in a tool that handles private transcripts.
- No stale `.lock` directory: the failure mode named as the main risk above goes away with the package.
- No `.wasm` file to ship and attribute.
- It was the fastest and leanest option in the spike.
- The file format is plain SQLite, so a second engine can be added later behind the same interface without a data migration.

History stays off until a user turns it on. #25 builds the core API only (`@orbitrace/core/node`); no host calls it yet.

### Which Node versions load `node:sqlite`

Run on 2026-11-27 on the test machine (macOS) with `npx -y node@<version>` and the local Node, each with `import("node:sqlite")`, then `new DatabaseSync(":memory:")` and `CREATE VIRTUAL TABLE ... USING fts5(x)`:

| Node                               | Loads without a flag                                                 | Warning printed                                                                       | FTS5                   |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------- |
| 20.20.2                            | no: `ERR_UNKNOWN_BUILTIN_MODULE` (No such built-in module)           | none                                                                                  | n/a                    |
| 22.12.0                            | no: `ERR_UNKNOWN_BUILTIN_MODULE`; loads with `--experimental-sqlite` | `ExperimentalWarning` with the flag                                                   | `no such module: fts5` |
| 22.13.1                            | yes                                                                  | `ExperimentalWarning: SQLite is an experimental feature and might change at any time` | `no such module: fts5` |
| 22.23.5 (`node@22`, SQLite 3.54.1) | yes                                                                  | the same `ExperimentalWarning`                                                        | yes                    |
| 23.11.1                            | yes                                                                  | the same `ExperimentalWarning`                                                        | `no such module: fts5` |
| 24.22.3 (`node@24`, SQLite 3.54.1) | yes                                                                  | none                                                                                  | yes                    |
| 26.5.0 (local, SQLite 3.54.1)      | yes                                                                  | none                                                                                  | yes                    |

The warning is printed once per process, on the first load. The VS Code 1.148.0 result above (Node 24.22.1, no warning) still stands. `--no-experimental-sqlite` turns the module off on Node 22.23.5 and 26.5.0 (`ERR_UNKNOWN_BUILTIN_MODULE`); the tests use it to check the unavailable path on any Node.

Two consequences:

- 22.12.0 does not load `node:sqlite` without a flag and 22.13.1 does, so on the 22 line the repository's `engines` floor (22.13) is where history becomes available (22.13.0 itself was not run). Node 20 never has it, so history is unavailable on Node 20 and the store's tests skip there, with the reason in the suite name. CI runs Node 20 and 22.
- FTS5 is missing in some builds that load the module (22.13.1, 23.11.1). `historyCapability()` reports `fts5: true | false`, so full-text search (#28) can check before it creates its table.

### Which VS Code versions load `node:sqlite` (#196)

Run on 2026-11-27 on the test machine (macOS, arm64). Each version was downloaded with `@vscode/test-electron` 3.1.0 (`downloadAndUnzipVSCode`, the downloader the integration test uses; the macOS arm64 archive of each release, about 130 MB) into a temporary folder outside the repository, then deleted. The editor binary ran as Node with `ELECTRON_RUN_AS_NODE=1`, printed `process.versions`, then ran `require("node:sqlite")`, `new DatabaseSync(":memory:")`, `sqlite_version()` and `CREATE VIRTUAL TABLE ... USING fts5(x)`. The launcher of the integration test does this (`packages/vscode/test-integration/runtime-probe.ts`):

```
ORBITRACE_IT_PROBE_ONLY=1 ORBITRACE_VSCODE_VERSION=<version> ORBITRACE_IT_CACHE_DIR=<absolute temporary folder> \
  npm run test:integration -w orbitrace-vscode
```

| VS Code                          | Electron | Node    | `node:sqlite`                    | SQLite | FTS5 | Warning printed       |
| -------------------------------- | -------- | ------- | -------------------------------- | ------ | ---- | --------------------- |
| 1.96.0 (lowest `engines.vscode`) | 32.2.6   | 20.18.1 | no: `ERR_UNKNOWN_BUILTIN_MODULE` | n/a    | n/a  | none                  |
| 1.100.0                          | 34.5.1   | 20.19.0 | no: `ERR_UNKNOWN_BUILTIN_MODULE` | n/a    | n/a  | none                  |
| 1.101.0                          | 35.5.1   | 22.15.1 | yes                              | 3.49.1 | no   | `ExperimentalWarning` |
| 1.102.0                          | 35.6.0   | 22.15.1 | yes                              | 3.49.1 | no   | `ExperimentalWarning` |
| 1.103.0                          | 37.2.3   | 22.17.0 | yes                              | 3.50.0 | yes  | `ExperimentalWarning` |
| 1.104.0                          | 37.3.1   | 22.18.0 | yes                              | 3.50.2 | yes  | `ExperimentalWarning` |
| 1.107.0                          | 39.2.3   | 22.21.1 | yes                              | 3.50.4 | yes  | `ExperimentalWarning` |
| 1.113.0                          | 39.8.3   | 22.22.1 | yes                              | 3.51.2 | yes  | `ExperimentalWarning` |
| 1.125.0                          | 42.2.0   | 24.15.0 | yes                              | 3.51.3 | yes  | none                  |
| 1.148.0 (stable on 2026-11-27)   | 43.8.10  | 24.22.1 | yes                              | 3.53.4 | yes  | none                  |

Only the `.0` release of each listed version was run; patch releases and the versions between the rows were not. So among the versions run, `node:sqlite` first loads in 1.101.0 and FTS5 first works in 1.103.0. Every VS Code that `engines.vscode: ^1.96.0` allows below 1.101.0 has no history: the store reports itself unavailable there, with the reason, and the rest of the extension works (checked in a real window on 1.96.0, below). The 1.148.0 row matches the runtime check at the top of this record.

### What #25 built against the five items above

1. One writer: an owner-checked pid lock file. A second writer waits (optional) or fails with `locked`; a lock left by a dead process is taken over. Readers take no lock. Tested in-process and across processes.
2. A writer killed mid-transaction (a child process blocked inside its third transaction, then `SIGKILL`): the next run takes over the lock and ends with exactly the lines of the files, none lost and none twice. Tested.
3. Writes off the main thread: a `worker_threads` entry (`dist/history/worker.js`) with progress and result messages. Tested in Node, and since #196 in a real VS Code extension host: the integration test (`packages/vscode/test-integration/history-steps.ts`) points `HOME`, `CLAUDE_CONFIG_DIR` and `ORBITRACE_DATA_DIR` at temporary folders, calls `historyCapability()` inside the host, runs `runHistoryIngestWorker` over 10 synthetic sessions (41 transcript files, 1,014 lines), checks the totals against a direct count, checks that a second run adds nothing, reads the totals back and deletes the store. Run locally on macOS (arm64) in a real window, all six steps passed on VS Code 1.148.0 and 1.101.0 (three runs: the worker took 58 to 296 ms; the longest gap of a 5 ms timer on the host thread during the run was 8 to 59 ms). On 1.96.0 the host reported `unavailable` with the reason "This Node.js (v20.18.1) has no node:sqlite module. History needs Node 22.13 or later.", the store and the worker both failed with `unavailable`, nothing was written, the four store steps were skipped with that reason, and the extension's own 15 steps passed. CI runs the suite on the current stable VS Code and on 1.96.0, on Linux under Xvfb; those CI runs had not happened when this was written. The extension itself does not call the history store yet; the test loads it from `@orbitrace/core/node`.
4. Partly done (#196). Linux: the core history tests already run in CI on Ubuntu with Node 20 (they skip there, with the reason), 22, 24 and 26, and CI runs the extension-host check above on Ubuntu. Windows: a CI job runs the core tests on `windows-latest` with Node 24, not blocking yet; it had not run when this was written, so nothing is confirmed on Windows. Read for Windows: Node's `chmod` there sets only the read-only flag (the 0700 / 0600 test skips on Windows), `child.kill("SIGKILL")` in the crash test ends the process with `TerminateProcess`, and the location checks compare paths case-insensitively on Windows. Not tested: Cursor and Windsurf (not installed), Windows in an extension host, VS Code on Linux outside CI.
5. The interface is narrow: capability, open (reader or writer), ingest, read back, delete one session, delete the store, close.

The file uses WAL journal mode, not the `journal_mode=DELETE` recommended above: with one engine, WAL lets readers read while the writer writes. A second engine that cannot open WAL files would need a checkpoint and `journal_mode=DELETE` first; the data does not change.

### Ingest speed

Synthetic sessions only, from the seeded generator (`generateSession("demo")`; the copies use seeds `speed-0` to `speed-199`). All folders (home, config, data) were temporary. One macOS laptop with other work running.

| Input                                                                            | Node    | First ingest                         | Second run (nothing new) | Database |
| -------------------------------------------------------------------------------- | ------- | ------------------------------------ | ------------------------ | -------- |
| `demo`, the largest scenario: 1 session, 15 transcript files, 549 lines, 0.44 MB | 26.5.0  | 28 ms (about 19,800 lines/s)         | 3 ms                     | 596 KB   |
| the same                                                                         | 22.23.5 | 31 ms                                | 2 ms                     | 596 KB   |
| 200 generated `demo` sessions: 108,696 lines, 87.0 MB                            | 26.5.0  | 4,252 ms (25,565 lines/s, 20.5 MB/s) | 301 ms                   | 113 MB   |
| the same                                                                         | 22.23.5 | 4,341 ms (25,042 lines/s, 20.0 MB/s) | 479 ms                   | 113 MB   |

The database is about 1.3 times the size of the transcripts: each line is stored as redacted JSON text with its key, and `secure_delete` is on.
