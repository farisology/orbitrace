# @orbitrace/core

The core of Orbitrace: it parses Claude Code session transcripts, finds sessions on disk, builds
the replay model that the orrery draws, and exports a structure-only replay file. It has no
editor or UI framework dependency.

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: not released.** This package is not on npm yet. Build it from the
[repository](https://github.com/farisology/orbitrace) (see
[getting started](https://github.com/farisology/orbitrace/blob/main/docs/getting-started.md)).

## Entry points

| Import                                         | What it holds                                                                                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbitrace/core`                              | The replay contract (types and constants), the transcript parser, the replay model builder and feed, export and validation, the host protocol and display formatters. Imports no Node module, so it also runs in a browser. |
| `@orbitrace/core/node`                         | The Claude Code source adapter (reads the config folder, lists and watches sessions) and the host-side session replayer. Node only.                                                                                         |
| `@orbitrace/core/schema/replay-v1.schema.json` | The JSON Schema of a replay file, version 1.                                                                                                                                                                                |

The package is ESM only and needs Node.js 20 or later for the Node entry.

## Documentation

- [Architecture](https://github.com/farisology/orbitrace/blob/main/docs/architecture.md): the packages and the data flow.
- [Replay format](https://github.com/farisology/orbitrace/blob/main/docs/replay-format.md): what a replay file holds.
- [Privacy](https://github.com/farisology/orbitrace/blob/main/docs/privacy.md): what Orbitrace reads and what a shared replay contains.

## Licence

MIT. See [LICENSE](LICENSE).
