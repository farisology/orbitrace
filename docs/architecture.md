# Architecture

Orbitrace reads the transcripts Claude Code already writes and replays a session as an orrery:
the main agent in the centre, subagents in orbit, tool calls around them. Orbitrace is an
independent project and is not affiliated with Anthropic.

This page describes the package boundaries, the data flow, where each piece lives and which
ticket built it. Ticket #2 wrote the contract; the parser, source resolution, the replay
builder, export, the ledger, the history store (in core only), the renderer, the app, the editor
extension and the command line with its loopback server and `doctor` are built on `dev`. What is
not built is listed in [Not built yet](#not-built-yet).
Nothing is published to npm or a marketplace; see [getting-started.md](getting-started.md).

## Packages

| Package               | Folder              | Role                                                                                                                                                                                                                                                                                                      | Depends on at run time                                                                                                                                                      |
| --------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbitrace/core`     | `packages/core`     | Raw, parsed and replay types; the replay v1 schema; the parser, source resolution, the replay builder and feed, export and validation, the ledger. The Node-only parts (the Claude Code adapter, its file watcher, the session replayer and the history store) are on the `@orbitrace/core/node` subpath. | nothing (Ajv is a dev dependency)                                                                                                                                           |
| `@orbitrace/renderer` | `packages/renderer` | Framework-free Canvas 2D engine that draws one replay model: `createOrrery`, and `createOrreryWithEnvironment` for an injected frame scheduler, pixel ratio and sprite surfaces.                                                                                                                          | core (`toRealSeconds`, `KNOWN_MODEL_FAMILIES`, types)                                                                                                                       |
| `@orbitrace/app`      | `packages/app`      | React and Vite shell: orrery, inspector, timeline, controls, event feed and session picker. Talks to its host only through `HostTransport`. Private.                                                                                                                                                      | core (`parseSession`, `buildReplay`, `validateReplay`, `describeReplayProblems`, `replayFeed`, `toRealSeconds`, `exportReplay`, `sessionLedger`); renderer (`createOrrery`) |
| `@orbitrace/fixtures` | `packages/fixtures` | Seeded generator of synthetic transcripts, the paths of the files in `fixtures/`, and the golden replay files. Used by tests and for the demo. Private.                                                                                                                                                   | core                                                                                                                                                                        |
| `orbitrace-vscode`    | `packages/vscode`   | Editor extension: a Sessions view, four commands and one editor tab per session, answered by the editor side of `HostTransport`. Private.                                                                                                                                                                 | core, bundled into `dist/extension.js`; the built app, copied into `dist/app` (both are devDependencies, see [below](#how-the-extension-ships-the-web-app-87))              |
| `orbitrace`           | `packages/cli`      | Command line: `list`, `export`, `open` and `doctor`; `open` serves the app over a loopback server. Private.                                                                                                                                                                                               | core, bundled into `dist/index.js` (#120); the built app, copied into `dist/app` (both are devDependencies, see [below](#how-the-cli-ships-the-web-app-76))                 |

Rules:

- `core` has no editor dependency. Its main entry has no Node or DOM dependency and uses only
  ES2022 types, so a dropped file in a browser and a file read in Node go through the same
  parser. See [The two entries of core](#the-two-entries-of-core).
- `renderer` has no framework dependency. It reads nothing but the replay model it is given.
- `app` never reads files from disk. It talks to its host only through `HostTransport`. A file
  the user drops or picks is read inside the page.
- Only a `ReplayModel`, `SessionSummary` values, `saveReplay` outcomes and path-free
  `{ code, message }` errors cross from a host to the app. Raw lines, parsed sessions, paths and
  locators stay on the host side, inside the session replayer from `@orbitrace/core/node` (#75).

## Data flow

```text
files on disk (host side)                                dropped or picked file (in the app)
        |                                                          |
        |  SourceAdapter.resolveRoots, listSessions,               |  .jsonl: whole text as one item
        |  openSession, watchSession                  (#7, #74)    |  .replay.json: validateReplay
        v                                                          v
SessionInput            raw lines + subagent meta           core/src/model/raw.ts
        |
        |  parseSession                                                 (#6)
        v
ParsedSession           merged replies, paired calls,       core/src/model/parsed.ts
        |               linked subagent runs, line counts
        |  buildReplay                                                  (#8)
        v
ReplayModel v1          structure only, schema-checked      core/src/model/replay.ts
        |                                                   core/schema/replay-v1.schema.json
        +--> exportReplay -> orbitrace.replay.json          (#18; from the app, #168)
        |
        +--> HostTransport: editor messages (#12) or loopback HTTP (#17)
                 |
                 v
             app  --setModel / updateModel / setTime-->  renderer (OrreryHandle)  (#11, #10)
```

On the host side, the session replayer from `@orbitrace/core/node` (#75) runs the chain from
`openSession` to the schema check, so the editor extension and the command line build replays
the same way.

Each arrow narrows the data. `SessionInput` can hold any user content, because it is the raw
transcript. `ParsedSession` keeps local ids (session id, runtime agent ids, tool use ids) so runs
can be linked, but no text, inputs, outputs, paths, branch, title or subagent description.
`ReplayModel` keeps no ids from the runtime at all.

## The two entries of core

- `@orbitrace/core` (`dist/index.js`) is browser-safe: nothing reachable from it imports a Node
  module. The app uses it in the browser and in the editor webview.
- `@orbitrace/core/node` maps through the `exports` field of `packages/core/package.json`
  (`./node`) to `dist/sources/node.js`. It holds the Claude Code adapter (#7), the session file
  watcher behind `watchSession` (#74), the session replayer (`createSessionReplayer`,
  `createNodeSessionReplayer`, #75), `nodeResolveContext` and the history store
  (`openHistoryStore`, `ingestHistory` and the rest, #25; see [History store](#history-store-25)).
  Hosts (the CLI, the editor extension) import these from here and everything else from `@orbitrace/core`. The replayer's
  update types (`SessionReplayUpdate`, `SessionReplayListener`) are also exported from the main
  entry, as types only (#84).
- The main entry must stay free of Node imports. Two tests guard this:
  `packages/core/test/sources/entry-points.test.ts` walks the imports of `src/index.ts` and
  checks which entry exports what, and `packages/fixtures/test/generator.test.ts` checks that the
  generator and the core files it reaches have no Node import. The type check enforces it too
  (#72): `packages/core/tsconfig.browser.json` checks `src` without Node's types and leaves out
  the `./node` entry (`src/sources/node.ts`, `src/sources/claude-code/` and `src/history/`), so a
  Node global, a `node:` import or an import of a `./node` file there fails `npm run typecheck`.
  `packages/core/tsconfig.json` checks `src` and `test` with Node's types. The build
  (`tsconfig.build.json`) emits the two entries as two projects,
  `tsconfig.browser.build.json` and `tsconfig.node.build.json`. What a contributor sees and how
  to add a Node-only file is in [AGENTS.md](../AGENTS.md#5-keep-changes-inside-one-package).
- The ledger (#26) is in `src/ledger/` and is browser-safe: `sessionLedger` totals one session's
  tokens in four classes and estimates their cost, by model and by agent, and the app's inspector
  shows it. See [ledger.md](ledger.md).

## Where each piece lives

Core functions are exported from `@orbitrace/core` unless the table says
`@orbitrace/core/node`. Renderer types and functions are exported from `@orbitrace/renderer`.
The transport messages (`TransportRequest`, `TransportMessage`) are defined in core
(`core/src/model/transport.ts`), with `TransportErrorCode` (`core/src/model/errors.ts`) and the
wire layout (meta tag names, fragment parameters, routes, request and message checks,
`core/src/protocol/`) (#96). `@orbitrace/app/transport` exports `HostTransport`, `LiveUpdate` and
`TransportError` and re-exports the message types and `TransportErrorCode`; `@orbitrace/app`
re-exports the wire layout.

| Ticket | What                                                                                                           | Where                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| #2     | The contract: types, constants, the replay v1 schema, `minimal.replay.json`                                    | `core/src/model/`, `core/src/api.ts`, `core/schema/replay-v1.schema.json` |
| #6     | `parseSession`                                                                                                 | `core/src/parser/`                                                        |
| #7     | `resolveSources`, `listSessions`; the Claude Code adapter (`@orbitrace/core/node`)                             | `core/src/sources/`                                                       |
| #8     | `buildReplay`, `replayFeed`, `DEFAULT_REPLY_PADDING_SECONDS`                                                   | `core/src/replay/`                                                        |
| #9     | Fixture generator and committed fixtures                                                                       | `packages/fixtures`, `fixtures/`                                          |
| #10    | `createOrrery`, `createOrreryWithEnvironment`                                                                  | `packages/renderer`                                                       |
| #11    | The app, coded against `HostTransport`; the no-host transport (`createNoHostTransport`, `createDemoTransport`) | `packages/app`                                                            |
| #12    | The editor side of `HostTransport`: the message host                                                           | `packages/vscode/src/message-host.ts`                                     |
| #16    | The `orbitrace` commands                                                                                       | `packages/cli/src/`                                                       |
| #17    | The loopback server and its routes                                                                             | `packages/cli/src/server/`                                                |
| #18    | `exportReplay`, `validateReplay`, `describeReplayProblems`, `assertReplay`                                     | `core/src/export/`                                                        |
| #71    | `toRealSeconds`, and its inverse `toCompressedSeconds` (#135)                                                  | `core/src/replay/real-time.ts`                                            |
| #73    | Golden replay files and their test, moved out of core                                                          | `packages/fixtures`, `fixtures/replays/`                                  |
| #74    | `watchSession` of the Claude Code adapter and `watchSessionFiles` (`@orbitrace/core/node`)                     | `core/src/sources/claude-code/watch.ts`, `adapter.ts`                     |
| #75    | `findSessionByKey`; the session replayer (`@orbitrace/core/node`)                                              | `core/src/sources/index.ts`, `core/src/host/session-replayer.ts`          |
| #85    | The wire layout shared by the app and both hosts                                                               | exported as `@orbitrace/app`                                              |
| #87    | How the extension ships the web app                                                                            | `packages/vscode/scripts/`                                                |
| #96    | One host protocol and one set of display formatters, shared from core                                          | `core/src/model/transport.ts`, `core/src/protocol/`, `core/src/format/`   |
| #25    | The history store (`@orbitrace/core/node`); no host uses it yet                                                | `core/src/history/`                                                       |
| #26    | The ledger: `sessionLedger`, the price table and `formatCostEstimate`                                          | `core/src/ledger/`                                                        |
| #31    | `orbitrace doctor`                                                                                             | `packages/cli/src/doctor/`                                                |
| #168   | Export from the app; the `saveReplay` request                                                                  | `packages/app/src/export-replay.ts`, `core/src/protocol/save-replay.ts`   |

`CoreApi` in `core/src/api.ts` lists the function signatures of the core surface.

### Contract notes

- Parser (#6): a transcript line whose `type` is not known is still a valid `RawLine`. It is
  skipped and counted in `ParsedSession.lines.unknownByType`. Blank lines are skipped and not
  counted; lines that are not a JSON object are counted as `malformed`. Assistant lines are
  merged by `message.id`: the maximum of each usage field and the union of `tool_use` blocks by
  block id.
- Sources (#7): root resolution order is user setting, `CLAUDE_CONFIG_DIR`, per-OS default,
  opt-in extra roots, hook paths (`SOURCE_RESOLUTIONS` in `core/src/model/sources.ts`). A
  dropped file is not a source root and has no `resolvedBy` value: it bypasses source resolution
  and is parsed by the app. The live registry is undocumented; the adapter treats it as optional
  and checks that its process is alive.
- Builder (#8): agent ids in a replay are `main`, `a1`, `a2`, ... in the order of the parent
  `Agent` call (see [Agent ids](replay-format.md#agent-ids)). With `BuildReplayOptions.previous`,
  the [append-stability rules](replay-format.md#append-stability-live-view) hold. `family` is the
  derived word even when the renderer does not know it. MCP tool names become `mcp:<server>`. The
  default `replyPaddingSeconds` is 3 (`DEFAULT_REPLY_PADDING_SECONDS`).
- Renderer (#10): the host owns the clock. The renderer never advances replay time on its own;
  the host calls `setTime` every frame while playing. `play`, `pause` and `setSpeed` only control
  motion that is not tied to replay time. `setModel` loads a different replay and clears
  selection and per-agent state; `updateModel` takes a newer snapshot of the same session and
  keeps both, keyed by agent id. A `family` outside `KNOWN_MODEL_FAMILIES` is drawn as `unknown`.
- App (#11): a session listed as live, or with an unknown status, is followed with `subscribe`;
  its first update goes to `setModel` and later ones to `updateModel`. A session listed as ended
  is read once with `loadReplay`.
- Hosts (#12, #17): each `subscribe` call is its own subscription. In editor messages the
  `subscribe` request's `id` is the subscription id; `unsubscribe` takes `{ subscriptionId }`, and
  every `live` message carries `subscriptionId` as well as `key`. The loopback server carries the
  same request and reply shapes over HTTP; see
  [Loopback server and routes](#loopback-server-and-routes-17).

## Session replayer and live updates (#75, #74)

`createNodeSessionReplayer(options)` from `@orbitrace/core/node` returns a `SessionReplayer`
over the Claude Code adapter and this process's roots (resolved again on every listing, so a
config folder created after start-up is found). Both hosts use it.

- `list` gives path-free `SessionSummary` values, newest first, and remembers each session.
- `load(key)` builds one replay: `openSession`, `parseSession`, `buildReplay`, then the schema
  check.
- `follow(key, listener)` sends the current state, then a rebuilt replay after each change the
  adapter's `watchSession` reports, each built with the last one as `previous`. Changes that
  arrive during a build are merged into one more build. With an adapter that has no
  `watchSession`, the current state is followed by `ended`.
- Every failure becomes a `TransportErrorCode` (`not-found`, `unreadable`, `invalid`,
  `internal`) with a fixed, path-free message.

**Where reply details travel (#203).** Every build of the replayer, for `load` and for each
`follow` update, uses `BuildReplayOptions.replyDetails`, so the model a host sends carries each
reply's cache writes by lifetime and its own model id where the transcript recorded them
(`ReplayReplyDetails`, in memory only). The replayer checks it with `describeReplayModelProblems`
(the details type-checked, the rest the strict replay v1 check), and the app's client decoder
(`packages/app/src/client-decode.ts`) checks what arrives over HTTP or from the editor with
`validateReplayModel`, the same rule, so any other unknown property is still refused. A
transcript dropped on the app is built with the details in the page. A replay file never holds
them: `exportReplay` drops them, so every export path (`orbitrace export`, the app's Export, the
editor's save) writes the same bytes as before, and a `.replay.json` opened in the app or the
public player is still checked with the exact `validateReplay`, so the ledger shows its fallback
note there. The CLI and the extension needed no change: both use this replayer. A host never
sends details to an app that cannot read them: the CLI and the extension each ship their own
copy of the built app (see How the CLI ships the web app (#76) and How the extension ships the
web app (#87)), so the decoder is always from the same build as the replayer; the decoder still
accepts a model without details.

The Claude Code adapter's `watchSession` watches the folders of the main transcript, the
session's `subagents/` folder and the live registry folder. The default mode, `auto`, uses
`fs.watch` events and keeps a polling check every 5 s beside them, because on network drives and
in some containers `fs.watch` starts without error and then reports nothing. A host that wants
polling only (for example for sessions on a network drive) passes
`adapters: [createClaudeCodeAdapter({ watch: { mode: "poll" } })]` to
`createNodeSessionReplayer`. No core change is needed. Neither host offers this as a setting yet.

A process that exits without touching a file (a crash, `kill -9`, a closed terminal) can leave
its registry entry behind, and file events alone never notice that (#139). So while the
session's last reported live status is `busy` or `idle`, `watchSession` also reads the live
registry and checks the process again on a timer, with no file change. When the status has
changed, the listener gets the session again; a process that is gone is reported as `ended`,
which ends follow in the app. The app also ends follow, and hides Go live, when the status is
`unknown`. The timer runs only while the status is `busy` or `idle`, starts again after each
read, stops when the watch is stopped, and never keeps the Node process alive on its own.

- `ClaudeCodeAdapterOptions.livenessIntervalMs` is the timer's interval in milliseconds; 0 turns
  the check off. When it is not set, or is not a finite number of 0 or more, the interval is the
  watch's `backstopIntervalMs` when that is greater than 0, otherwise 5000. So
  `watch: { backstopIntervalMs: 0 }` turns off the backstop poll but not this check.
- `livenessIntervalOf(options)` returns the interval a set of `ClaudeCodeAdapterOptions` gives.
- `SESSION_WATCH_DEFAULTS` holds the defaults of `SessionWatchOptions`: `debounceMs` 100,
  `maxWaitMs` 1000, `pollIntervalMs` 1000, `backstopIntervalMs` 5000 and `settleMs` 250.

All three are exported from `@orbitrace/core/node`, not from the main entry.

## History store (#25)

A copy of each session's transcript lines, redacted, in one SQLite file, so a session outlives
Claude Code's cleanup. Built in core and exported from `@orbitrace/core/node`; **no host calls it
yet**, and nothing is written unless a caller opens a store for writing and calls the ingest.
Importing the module does nothing. The engine decision and its measurements are in
[decisions/0001-storage.md](decisions/0001-storage.md); what is stored and what redaction does
not catch is in [privacy.md](privacy.md#history-store-25).

- **Engine.** `node:sqlite`, loaded by a dynamic import inside `try`/`catch` on first use.
  `historyCapability()` says whether it loads (Node 22.13+, Node 24 in current VS Code) and, when
  it does not (Node 20, older editor hosts), why. On such a runtime every store call fails with
  `HistoryStoreError` code `unavailable` and the rest of core is unaffected. It also reports
  whether this SQLite has FTS5, for #28.
- **Interface.** `openHistoryStore({ mode: "write" | "read" })` returns a `HistoryStore`:
  `totals()`, `listSessions()`, `readSession(key)` (a `SessionInput` for `parseSession`),
  `deleteSession(key)` and `scrub()` (writer) and `close()`. `ingestHistory(store, { sessions } | { roots })`
  copies sessions in. `deleteHistoryStore()` removes the whole store and works without
  `node:sqlite`. Errors are `HistoryStoreError` with a code and a message that names no path.
- **Location.** `ORBITRACE_DATA_DIR` (absolute) or `.orbitrace` in the home folder; files
  `history.sqlite` (plus SQLite's `-wal` and `-shm`) and `history.lock`. Refused inside a git
  working tree or a Claude Code config folder. Folder 0700, files 0600.
- **Schema** (version 1 in `PRAGMA user_version`, `application_id` `ORBT`): `sessions` (one row
  per `SessionRef.key`), `files` (one per transcript file, with the subagent's redacted meta, the
  file's device and inode, the byte offset read up to, hashes of the first and last 4 KiB before
  it, and a generation), `lines` (redacted JSON text, keyed by file, base key and occurrence). A
  later version is a numbered migration applied by the next writer; a reader of an older file
  fails with `needs-upgrade` and of a newer one with `newer-schema`.
- **Incremental ingest.** Each run reads every transcript file from its stored offset and stores
  complete lines only; a partial last line waits for the next run. A line's key is its `uuid`, or
  a hash of its redacted text, plus how often that key came before in the file, so a second run
  adds nothing and identical lines are kept apart. A file whose inode changed, that shrank below
  the offset, or whose first or last 4 KiB before the offset changed is read again from the start
  under a new generation, and lines already stored are recognised by their keys. Lines no longer
  in a file stay stored. Lines go in transactions of 1,000 (`batchLines`) together with the new
  offset, so a killed writer loses nothing and duplicates nothing. The file uses WAL journal
  mode, so readers are not blocked by the writer, and `synchronous = NORMAL`: in WAL mode that
  keeps the file consistent after a crash or power loss but can roll back the last commits on
  power loss, which is safe here because each file's offset commits in the same transaction as its
  lines, so the next run re-reads the lost lines (nothing lost, nothing duplicated); `FULL`'s fsync
  on every commit would buy nothing.
- **One writer.** A writer takes `history.lock`, a pid file written to a temporary name and
  hard-linked into place (exclusive create where links are not supported). A live holder makes a
  second writer wait up to `lockWaitMs` and then fail with `locked`; a lock whose pid is gone is
  renamed aside, checked and removed; a lock from another host counts as held. Release removes
  the file only when it still holds the owner's token. Readers take no lock; WAL mode lets them
  read during a write. Within one process, one store object runs one write at a time: a second
  `ingestHistory` call on the same store waits for the first to end and then continues from where
  it stopped, and `deleteSession` and `scrub` fail with `locked` while an ingest runs.
- **Off the main thread.** `runHistoryIngestWorker(request, options)` starts the worker entry
  `dist/history/worker.js` with `worker_threads`, forwards `progress` after each session and
  resolves with the result; `signal` terminates it. Because a worker shares its parent's pid, a
  lock it leaves behind would look held by a live process, so the helper makes the lock token
  before it starts the worker, passes it in `workerData`, and on the worker's `exit` removes the
  lock file (only if it still holds that token) and the side files named after the token, however
  and whenever the worker ended. `ingestHistory`
  itself reads files synchronously and yields to the event loop between transactions.
- **Deleting.** `deleteSession` runs with `secure_delete` on and then checkpoints the WAL with
  `TRUNCATE`, so the session's bytes are overwritten in the database and, when no reader is inside
  a read, gone from the WAL file. The checkpoint's result row and the WAL size are checked, with
  three short attempts (150 ms busy timeout each); when a reader keeps the WAL in use it returns
  `{ deleted: true, scrubbed: false }` and the caller retries with `scrub()` once readers close.
  `deleteHistoryStore` takes the lock and deletes the database, its `-wal`, `-shm` and `-journal`
  files and the lock, then the folder if it is empty.

What a host needs before it can call this (later tickets): ship `dist/history/worker.js` as its
own file next to its bundle and pass its location as `workerUrl`, which is required because a
bundler moves the module away from the worker file and the extension's CommonJS bundle has no
`import.meta.url`; check `historyCapability()` before offering history; and keep recording off
until the user turns it on.

## Export and validation (#18)

`exportReplay` builds a new value from an allow-list of the replay fields, checks it against the
replay v1 schema and writes JSON with keys in a fixed order. The file name is always
`orbitrace.replay.json`. `orbitrace export` and the app's Export button (#168) both write through
it, so with no option chosen they write the same bytes for the same session. What export
guarantees and what it does not is in [privacy.md](privacy.md#what-a-shared-replay-contains).

Export and validation use a validator precompiled from the schema,
`packages/core/src/export/replay-v1-validator.generated.ts`, made with Ajv's standalone code and
the same options as the schema test (`strictTuples` off). So they need no Ajv, no schema file and
no `new Function` at run time, and run in Node, a browser and an editor webview alike. Ajv stays a
dev dependency. `test/export/validator-source.test.ts` fails when the generated file no longer
matches the schema. To regenerate, from `packages/core`:

```sh
npx vitest run -u test/export/validator-source.test.ts
```

### Saving a replay from an editor tab (#168)

A webview cannot download a file, so the app in an editor tab sends the exported text to the
extension with one more request, `saveReplay` (`core/src/protocol/save-replay.ts`). It is
additive: it sits beside the `TransportRequest` union, which does not change, and only the editor
host takes it. The loopback server does not; in a browser the app downloads the file itself.

- The request is `{ id, method: "saveReplay", params: { data } }`. `data` is the text
  `exportReplay` returned. It carries no path and no file name.
- The host checks it with `checkSaveReplayRequest` (at most 50 MiB of UTF-8), parses it, checks
  it with `validateReplay` and writes it again through `exportReplay`, so nothing beyond the
  allow-listed fields can reach the file. Then the editor's save dialog asks the user where to
  save it, suggesting `orbitrace.replay.json`.
- The reply is a `result` of `{ outcome: "saved" }` or `{ outcome: "cancelled" }` (the user
  closed the dialog), or an `error` with a fixed `{ code, message }` that names no path:
  `bad-request` (malformed or too large), `invalid` (not a valid replay), `internal` (the file
  could not be written) or `unsupported` (a tab that cannot save).
- The extension's demo tab has no host, so the app shows no Export button there.

## Renderer commands (#10)

Run from `packages/renderer`, after `npm run build` at the repository root:

```sh
npm run dev             # demo page with a synthetic session (Vite, 127.0.0.1)
npm run bench:browser   # the demo benchmark in headless Chrome (CHROME_PATH to override)
```

`bench:browser` needs Node 22 or later (it uses the global `WebSocket`) and a Chrome or Chromium
install. The renderer's own README describes the demo page parameters and the module layout.

## How the CLI ships the web app (#76)

Decision by the lead on #76: option (a). Implemented by #16; since #120 the CLI is one bundled
file that needs no other package.

- `npm run build` in `packages/cli` runs `scripts/build.mjs`. It removes the old `dist/`, then
  esbuild bundles `src/index.ts` and everything it imports, `@orbitrace/core` included (its main
  and its `/node` entry), into one ES module, `dist/index.js`, for Node.js 20 or later. Node
  built-ins stay external. There are no source maps and no type declarations, and the file is
  made executable. The build fails if code from a third-party package (any input under
  `node_modules`) ends up in the bundle, so a new bundled dependency cannot ship before its
  licence is noted in `NOTICE`.
- Then `scripts/copy-app.mjs` copies the built web app (`packages/app/dist`, without its `types/`
  folder of declarations) into `packages/cli/dist/app`. It fails when
  `packages/app/dist/index.html` is missing, so a CLI build never ships without the app.
- `@orbitrace/core` and `@orbitrace/app` are devDependencies of the CLI. That is enough for
  `scripts/run-workspaces.mjs` to build both before the CLI. Neither is a run-time dependency:
  the CLI's `package.json` has no `dependencies`, so an installed tarball needs nothing else. The
  app does not need to be published or to export its build output.
- `files` in `packages/cli/package.json` is `["dist/index.js", "dist/app"]`, so a packed CLI
  carries the command and the app, and no `src/`, maps or declarations. The package is marked
  private and is not published yet.
- At run time `appBundleDir()` (`packages/cli/src/app-bundle.ts`, bundled into `dist/index.js`)
  returns the `app/` folder beside the bundle, or `null` when it holds no `index.html`. The
  loopback server (#17) serves from that folder. `test/app-bundle.test.ts` imports the built
  `dist/index.js` and checks that it finds `index.html`; `test/build.test.ts` checks that `dist/`
  holds only `index.js` and `app/`, and that the bundle is executable and imports only Node
  built-ins.

The tarball checks and the offline install check of the CLI are in
[releasing.md](releasing.md#artefacts).

Option (b), publishing `@orbitrace/app` with its assets as a runtime dependency and resolving
them with `import.meta.resolve`, was not chosen: it adds a second published package and an
export for static files.

## How the extension ships the web app (#87)

The same approach as the CLI (decision on #76); the extension keeps its own copy step, because
packages do not import each other's build scripts.

- `@orbitrace/core` and `@orbitrace/app` are devDependencies of `orbitrace-vscode`, so
  `scripts/run-workspaces.mjs` builds both before the extension.
- `npm run build` in `packages/vscode` runs `scripts/build.mjs`: it syncs the copied assets
  (the activity-bar icon and the licence), then esbuild bundles `src/extension.ts` with core into
  one CommonJS file, `dist/extension.js`, for Node 20, with `vscode` external and no source maps.
  Then `scripts/copy-app.mjs` copies the app's `dist` into `dist/app`, without `types/` and
  without `*.map` files. It fails when the app's `index.html` is missing.
- Each editor tab is a webview with `localResourceRoots` limited to `dist/app`. The page is the
  app's `index.html` with a `<base href>` set to `asWebviewUri(dist/app)`, so the app's relative
  asset URLs resolve, and the host meta tags: `orbitrace-host` = `editor`, and `orbitrace-session`
  with the session key. The demo tab carries neither tag, so the app serves its bundled demo.
- The page's Content-Security-Policy allows scripts, styles, images and fonts only from the
  webview resource origin, with no inline script or style, and blocks every network request
  (`connect-src 'none'`), frames, workers, objects and forms (`src/webview-html.ts`).
- `test/build.test.ts` requires the built bundle in Node with a fake `vscode` module, activates
  it, opens the demo tab and checks that the page carries the policy and the app's script. It
  also checks that the bundle requires nothing but `vscode` and Node built-ins, holds no build
  path, and that `dist/` has no type declarations or source maps.
- `files` in `packages/vscode/package.json` limits a `.vsix` to `dist/extension.js`, `dist/app`,
  `media`, `LICENSE` and `README.md`.

## Loopback server and routes (#17)

`orbitrace open` (and a bare `orbitrace`) starts a server on Node's own `http` module
(`packages/cli/src/server/`), prints a link and opens it in the default browser. The route layout
is the lead's decision on #17; the server implements it on top of core's session replayer
(`createNodeSessionReplayer`, #75).

### Link

`http://127.0.0.1:<port>/#t=<token>&key=<session key>`. `key` is left out to open the session
list. The token and key are in the fragment, so the browser never sends them in a request line
or a `Referer` header. The app reads the fragment with `URLSearchParams`, then removes it from
the address bar. Values are percent-encoded outside `A-Z a-z 0-9 - . _ ~ :`.

### Routes

| Route                    | Token | Body in                          | Reply                                                                                               |
| ------------------------ | ----- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET` or `HEAD` any path | no    | none                             | A file of the built web app (`appBundleDir()`); `/` is `index.html`.                                |
| `POST /api/rpc`          | yes   | one `TransportRequest`           | One `TransportMessage` (`result` or `error`), `200`.                                                |
| `POST /api/live`         | yes   | `{ "id": <number>, "key": "…" }` | `200`, `application/x-ndjson`: one `live` `TransportMessage` per line, the first the current state. |

- `/api/rpc` answers `listSessions`, `loadReplay`, `unsubscribe` and `openInBrowser`.
  `openInBrowser` answers with an `unsupported` error. `subscribe` answers with an `unsupported`
  error too: follow a session with `/api/live`. `unsubscribe` ends the `/api/live` stream whose
  `id` it names.
- `/api/live` ends after an `ended` or `error` update. The client aborting the request is the
  unsubscribe: the server stops following the session and stops its watch. The CLI uses the
  Claude Code adapter, whose `watchSession` reports changes, so a stream follows the session
  until it is aborted or fails.
- A request the server refuses before there is a `TransportMessage` gets a non-200 status and the
  JSON body `{ "error": { "code": <TransportErrorCode>, "message": "…" } }`, with fixed,
  path-free messages:

| Status | Code           | When                                                                                                 |
| ------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| 400    | `bad-request`  | Body is not JSON or not a valid request.                                                             |
| 401    | `unauthorized` | Missing or wrong `Authorization: Bearer <token>`.                                                    |
| 403    | `unauthorized` | Host header is not `127.0.0.1:<port>` or `localhost:<port>`, or the request comes from another page. |
| 404    | `not-found`    | No such file, or an `/api` path that is not a route.                                                 |
| 405    | `unsupported`  | Another method (including `OPTIONS`, so every CORS preflight is refused).                            |
| 409    | `unsupported`  | A live stream with that `id` is already open.                                                        |
| 413    | `bad-request`  | Body larger than 64 KiB.                                                                             |
| 415    | `bad-request`  | `Content-Type` is not `application/json` (optionally `; charset=utf-8`), or the body is encoded.     |
| 429    | `unsupported`  | 16 live streams are open already.                                                                    |
| 500    | `internal`     | An unexpected error in the server. The message is fixed and holds no path.                           |
| 503    | `internal`     | The server is shutting down.                                                                         |

The table lists every `refuse(...)` call in `packages/cli/src/server/server.ts`; change the two
together.

### Checks, in order

1. **Listen on loopback only.** The server binds `127.0.0.1` on a port the system picks (or
   `--port`), and refuses to start if the bound address is anything else. Nothing listens on
   other interfaces or on IPv6.
2. **Host header**, on every request, static files included: `127.0.0.1:<port>` or
   `localhost:<port>`, without regard to case. Anything else is `403`.
3. **`/api` only:** method `POST`; then, when the browser sends them, `Origin` must be this
   server's origin and `Sec-Fetch-Site` must be `same-origin` or `none` (`same-site` is refused,
   because a page on another port of `127.0.0.1` is the same site); then the token; then the
   content type; then the body size, read with a hard limit.
4. **Token:** 32 bytes from `crypto.randomBytes`, base64url, new on every start. Read from the
   `Authorization` header only (never a query string, cookie or body), and compared in constant
   time (both sides hashed with SHA-256, then `timingSafeEqual`).
5. **Static files:** the path is decoded once and split into segments; a segment that is empty,
   `.`, `..`, hidden (starts with `.`), or holds a backslash, a colon or a NUL is refused. The
   joined path and its real path (symlinks followed) must both be inside the app folder, the file
   is opened with `O_NOFOLLOW` where the OS has it, and only regular files are served.

Every reply carries `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src
'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri
'none'; form-action 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy:
same-origin`, `Cross-Origin-Resource-Policy: same-origin` and `Cache-Control: no-store`. No reply
carries a CORS header (`Access-Control-*`) or sets a cookie. Header and request timeouts, a cap of
128 connections and the 16-stream cap bound what one client can hold open.

### Opening the browser

Other accounts on the machine can read the arguments of every process (`ps` on macOS,
`/proc/<pid>/cmdline` on Linux), and an opener such as `xdg-open` hands its argument to the
browser, which keeps it in its own arguments for its whole life when the opener had to start it.
So the link is never an argument. `orbitrace open` writes a launcher page instead: `open.html`,
mode `0600`, in a new folder from `fs.mkdtemp` under the system's temporary folder (mode `0700`).
The page holds the link in `<meta http-equiv="refresh" content="0;url=…">` (the fragment is
kept; no script) and a plain link as a fallback. The opener gets the page's path: `open <path>`
on macOS, `xdg-open <path>` on Linux and other systems, `cmd.exe /d /v:off /s /c "start ""
"<path>""` on Windows, through `spawn` with an argument array and no shell. The path is checked
first (absolute, ends in `.html`, no control characters; on Windows a drive path without `"`,
`%`, `!` or `^`), and the link written into the page must match the server's own link pattern.
The page and its folder are deleted when the server stops, and at once if the opener could not
start. This is the approach Jupyter uses for the same problem.

### Threat model

What the server protects: the session list (project names, session ids, times) and the replays
of every session the CLI can see, for as long as it runs.

| Threat                                                                                                                        | What stops it                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Another web page in the user's browser reads the API (any origin, including another port of `127.0.0.1`).                     | It cannot know the token. A request that sets `Authorization` needs a CORS preflight, which is refused; without CORS headers a reply cannot be read anyway. `Origin` and `Sec-Fetch-Site` from another page are refused.                                                 |
| A cross-origin "simple" POST (a plain HTML form, or `fetch` with `text/plain`).                                               | No token (`401`), and only `application/json` is accepted (`415`). The API has no action that changes anything but ending one's own live stream, which needs the token too.                                                                                              |
| DNS rebinding: a page on an attacker's name that resolves to `127.0.0.1`, which the browser treats as that page's own origin. | The Host header carries the attacker's name and is refused (`403`), and the page still has no token.                                                                                                                                                                     |
| Another machine on the network.                                                                                               | The server listens on `127.0.0.1` only.                                                                                                                                                                                                                                  |
| Another user account on the same machine (loopback is shared; process arguments are visible to every account).                | The token: 256 random bits, new on every start. The link is never a command-line argument: the browser opener gets the path of a launcher page (see below), so neither the opener's nor a newly started browser's arguments hold the token.                              |
| The token leaking through a request line, `Referer`, cookie, cache, log or process list.                                      | It is in the fragment, read from the `Authorization` header only, never set as a cookie, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, never passed as a program argument, and written only to stdout (the link) and to the launcher page, never to stderr. |
| Reading files outside the app folder through the static route.                                                                | Segment checks, containment checks on the joined and the real path, `O_NOFOLLOW`, regular files only.                                                                                                                                                                    |
| Exhausting the process with large or many requests.                                                                           | 64 KiB body limit, header and request timeouts, connection and stream caps.                                                                                                                                                                                              |
| Framing the app (clickjacking) or injecting script into it.                                                                   | `frame-ancestors 'none'` and `X-Frame-Options: DENY`; a CSP with no inline script, no `eval` and no other origin.                                                                                                                                                        |

What the token does **not** protect against:

- **Another process running as the same user.** It can read the transcripts from disk directly,
  without the server, and it can read the terminal the link was printed in. The server adds no
  protection against it and takes none away.
- **Anyone the link is given to** who can reach `127.0.0.1` on this machine, while the server
  runs. The token is not bound to one browser and does not expire before the server stops.
- **Browser extensions** allowed to read every page, and a compromised browser: they see the page,
  the token and the data.
- **The link in browser history.** The browser may record the address with the fragment before the
  app removes it. The token is worthless once that server run has stopped.
- **An administrator (root) account**, which can read loopback traffic (plain HTTP) and the files.
- **The link on a command line you start yourself.** The CLI never puts the link in a program's
  arguments, but if you pass it to a browser yourself (for example `firefox '<link>'`), other
  accounts can see it in the process list for as long as that browser runs. On a shared machine,
  use `--no-browser` and paste the link into a browser that is already running.
- **The launcher page after a hard stop.** If the process is killed (`SIGKILL`, a crash), the
  launcher page stays in the temporary folder. Only your account can read it, and its token is
  worthless once that server run has ended.
- **An opener that does not reach a browser.** `.html` files go to the program the system has for
  them. If that is an editor, or a browser installed as a Snap or Flatpak that cannot read the
  system's temporary folder, the page does not open the app; use `--no-browser` and open the link
  yourself.

## Adding another agent runtime

Claude Code is the only runtime. To add one:

1. Add its id to `RUNTIME_IDS` in `core/src/model/sources.ts` (`RuntimeId` is derived from it).
2. Write a `SourceAdapter` for it that produces a `SessionInput`. Put it behind
   `@orbitrace/core/node` if it reads files.
3. If its transcript lines differ from Claude Code's, give it a parser that returns a
   `ParsedSession`.

Nothing in the replay model, the renderer, the app or the transport refers to a specific runtime.

## Not built yet

- **Publishing.** No package is on npm, and the extension is not on the VS Code Marketplace or
  Open VSX. `@orbitrace/app`, `@orbitrace/fixtures`, `orbitrace` and `orbitrace-vscode` are
  marked private.
- **A history record in use.** The store exists in core (see [History store](#history-store-25)),
  but no host calls it, so nothing is stored.
- **Hooks.** Core resolves roots from hook-reported transcript paths, but no host passes any.
- **Host settings.** The extension has no settings: it reads `CLAUDE_CONFIG_DIR` or the default
  config folder only, with no extra roots and no polling mode. The command line takes
  `--config-dir` and `--extra-roots`.
- **Opening a session in the browser from the editor.** The editor host answers `openInBrowser`
  with `unsupported`.
- **A Claude Code plugin package.**
