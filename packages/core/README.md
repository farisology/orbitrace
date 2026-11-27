# @orbitrace/core

The core of Orbitrace: it parses Claude Code session transcripts, finds sessions on disk, builds
the replay model that the orrery draws, and exports a structure-only replay file. It has no
editor or UI framework dependency.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** This package is not on npm yet. Build it from the
[repository](https://github.com/farisology/orbitrace) (see
[getting started](https://github.com/farisology/orbitrace/blob/main/docs/getting-started.md)).

## Entry points

| Import                                         | What it holds                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbitrace/core`                              | The replay contract (types and constants), the transcript parser, the replay model builder and feed, export and validation, the host protocol and display formatters, and the ledger. Imports no Node module, so it also runs in a browser. |
| `@orbitrace/core/node`                         | The Claude Code source adapter (reads the config folder, lists and watches sessions), the host-side session replayer, and the history store. Node only.                                                                                     |
| `@orbitrace/core/history-worker`               | The history store's worker thread entry, a file to start with `runHistoryIngestWorker`, not a module to import. A host that bundles core ships it as a file of its own.                                                                     |
| `@orbitrace/core/schema/replay-v1.schema.json` | The JSON Schema of a replay file, version 1.                                                                                                                                                                                                |

The package is ESM only and needs Node.js 20 or later for the Node entry. The history store needs
`node:sqlite` (Node 22.13 or later); on an older Node it reports itself unavailable with the
reason, and the rest of the package works.

Some exports a host needs, and the entry each comes from:

| Export                                               | Entry                  | What it does                                                                                                                                                                           |
| ---------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionLedger`, `formatCostEstimate`                | `@orbitrace/core`      | Total one session's tokens in four classes and estimate their cost at list prices, by model and by agent ([ledger](https://github.com/farisology/orbitrace/blob/main/docs/ledger.md)). |
| `cacheWriteBasis`                                    | `@orbitrace/core`      | Say how a ledger entry's cache writes were priced: `none`, `recorded`, `unrecorded` or `mixed`.                                                                                        |
| `validateReplayModel`, `describeReplayModelProblems` | `@orbitrace/core`      | Check an in-memory replay model whose replies may carry reply details (built with `buildReplay`'s `replyDetails` option). Use `validateReplay` for a file.                             |
| `withoutReplyDetails`, `REPLY_DETAIL_KEYS`           | `@orbitrace/core`      | Copy a model without its reply details, for a receiver that takes only a replay file's shape; the names of those details.                                                              |
| `historyCapability`                                  | `@orbitrace/core/node` | Whether `node:sqlite` loads in this Node, and why not when it does not; whether its SQLite has FTS5.                                                                                   |
| `openHistoryStore`, `ingestHistory`                  | `@orbitrace/core/node` | Open the history store as a reader or the one writer, and copy sessions into it, redacted and incrementally.                                                                           |
| `runHistoryIngestWorker`, `deleteHistoryStore`       | `@orbitrace/core/node` | Run the ingest in a worker thread; delete the whole store, which works without `node:sqlite`.                                                                                          |

What the history store keeps and what its redaction does not catch is in
[privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md#history-store-25).

## Documentation

- [Architecture](https://github.com/farisology/orbitrace/blob/main/docs/architecture.md): the packages and the data flow.
- [Replay format](https://github.com/farisology/orbitrace/blob/main/docs/replay-format.md): what a replay file holds.
- [Privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md): what Orbitrace reads and what a shared replay contains.

## Licence

MIT. See [LICENSE](LICENSE).
