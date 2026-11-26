# 0001. Storage for the history index

Status: proposed. Ticket: #24 (spike). Date: 2026-11-26.

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

| Engine | Node 26.5.0 | VS Code (Node 24.22.1) | Node 19.8.1 |
| --- | --- | --- | --- |
| `node:sqlite` | FTS5 yes | FTS5 yes | module missing |
| `sql.js` 1.17.0 | `no such module: fts5` | `no such module: fts5` | `no such module: fts5` |
| `node-sqlite3-wasm` 0.8.61 | FTS5 yes | FTS5 yes | FTS5 yes |
| `@sqlite.org/sqlite-wasm` 3.54.1-build1 | FTS5 yes | FTS5 yes | FTS5 yes (despite `engines >=22`) |

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

| Option | Write (ms) | File size | Start before first query | RSS added (MB) |
| --- | --- | --- | --- | --- |
| (a) `node:sqlite` | 460 to 808 | 27.1 MB | open the file | about 0 to 19 |
| (b1) `node-sqlite3-wasm` | 772 to 1,684 | 27.1 MB | open the file | 21 to 110 |
| (b2) `@sqlite.org/sqlite-wasm` | 960 to 1,675 (export 22 to 33) | 26.5 MB | read whole file into memory | 133 to 177 |
| (c) JSON lines + index | 44 to 76 | 20.9 MB | index build 441 to 776 ms | 90 to 117 |

Node 19.8.1, one run: `node:sqlite` failed to load. Write times were 717 ms for (b1) and 918 ms for (b2). For (c), the write took 186 ms and the index build 525 ms.

Query times on VS Code's Node 24.22.1 (first run), median of 20, `count / top20` in ms:

| Query | Matches | (a) node:sqlite | (b1) node-sqlite3-wasm | (b2) sqlite-wasm | (c) in-memory index |
| --- | --- | --- | --- | --- | --- |
| rare term | 51 | 0.015 / 0.044 | 0.261 / 0.288 | 0.054 / 0.304 | 0.001 / 0.037 |
| medium term | 1,499 | 0.055 / 1.87 | 0.54 / 3.032 | 0.211 / 0.574 | 0 / 0.029 |
| common term | 15,240 | 0.471 / 8.983 | 1.913 / 10.563 | 1.376 / 6.402 | 0 / 0.023 |
| two terms AND | 799 | 0.245 / 1.385 | 0.711 / 2.685 | 0.554 / 0.709 | 0.096 / 0.056 |
| phrase | 512 | 0.236 / 0.863 | 0.848 / 1.6 | 0.509 / 0.691 | 0.179 / 0.214 |

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
