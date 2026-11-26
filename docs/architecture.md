# Architecture

Orbitrace reads the transcripts Claude Code already writes and replays a session as an orrery:
the main agent in the centre, subagents in orbit, tool calls around them.

This page describes the package boundaries, the data flow, and which interface each ticket
implements. Ticket #2 wrote the interfaces. Most of what they describe is not built yet; each
section says what exists.

## Packages

| Package               | Folder              | Role                                                                                      | Depends on                          |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `@orbitrace/core`     | `packages/core`     | Raw and parsed types, replay model and schema, source adapters, parser, builder, export.  | nothing                             |
| `@orbitrace/renderer` | `packages/renderer` | Framework-free Canvas 2D engine that draws one replay model.                              | core (types only)                   |
| `@orbitrace/app`      | `packages/app`      | React and Vite shell: inspector, timeline, controls, feed. Hosts the renderer.            | core (types), renderer (later)      |
| `orbitrace-vscode`    | `packages/vscode`   | Editor extension: opens the app in an editor tab and serves it over the host transport.   | nothing yet                         |
| `orbitrace`           | `packages/cli`      | Command line: lists sessions, opens the app in a browser over a loopback server, exports. | core; app and renderer (dev, types) |

Rules:

- `core` has no editor dependency and no DOM dependency. Its interfaces use only ES2022 types,
  so a dropped file in a browser and a file read in Node go through the same parser.
- `renderer` has no framework dependency. It reads nothing but the replay model it is given.
- `app` never reads files. It talks to its host only through `HostTransport`.
- Only a `ReplayModel`, `SessionSummary` values and path-free `{ code, message }` errors cross
  from a host to the app. Raw lines, parsed sessions, paths and locators stay on the host side,
  inside the session replayer from `@orbitrace/core/node` (#75).

## Data flow

```text
files on disk / dropped file
        |
        |  SourceAdapter.resolveRoots, listSessions, openSession        (#7)
        v
SessionInput            raw lines + subagent meta              core/src/model/raw.ts
        |
        |  parseSession                                                 (#6)
        v
ParsedSession           merged replies, paired calls,          core/src/model/parsed.ts
        |               linked subagent runs, line counts
        |  buildReplay                                                  (#8)
        v
ReplayModel v1          structure only, schema-checked         core/src/model/replay.ts
        |                                                              core/schema/replay-v1.schema.json
        +--> exportReplay -> .replay.json                               (#18)
        |
        +--> HostTransport (editor messages or loopback HTTP)           (#11, #12, #16)
                 |
                 v
             app  --setModel / updateModel / setTime-->  renderer (OrreryHandle)  (#11, #10)
```

Each arrow narrows the data. `SessionInput` can hold any user content, because it is the raw
transcript. `ParsedSession` keeps local ids (session id, runtime agent ids, tool use ids) so runs
can be linked, but no text, inputs, outputs, paths, branch, title or subagent description.
`ReplayModel` keeps no ids from the runtime at all.

## Interfaces and who implements them

All core interfaces are exported from `@orbitrace/core`. Renderer types are exported from
`@orbitrace/renderer`. Transport types are exported from `@orbitrace/app/transport`;
`TransportErrorCode` is defined in core (`core/src/model/errors.ts`) and re-exported there.

| Ticket | Implements                                                                                  | Against                                                                                            | File                                                    |
| ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| #6     | `parseSession: ParseSession`                                                                | `SessionInput`, `RawLine`, `RawSubagentMeta` in; `ParsedSession` out                               | `core/src/api.ts`, `core/src/model/raw.ts`, `parsed.ts` |
| #7     | Claude Code `SourceAdapter`; `resolveSources: ResolveSources`; `listSessions: ListSessions` | `SourceRoot`, `SessionRef`, `ResolveRootsContext`, `RawLiveRegistryEntry`                          | `core/src/model/sources.ts`, `core/src/api.ts`          |
| #8     | `buildReplay: BuildReplay`                                                                  | `ParsedSession` in; `ReplayModel` out; `BuildReplayOptions`, `REPLAY_BUILD_DEFAULTS`               | `core/src/api.ts`, `core/src/model/replay.ts`           |
| #9     | Synthetic transcript and replay fixtures                                                    | `RawLine` and `RawSubagentMeta` shapes; replays must validate against the v1 schema                | `fixtures/`                                             |
| #10    | `createOrrery: CreateOrrery`                                                                | `OrreryHandle`, `OrreryOptions`, `OrreryEvents`; draws a `ReplayModel`                             | `renderer/src/api.ts`                                   |
| #11    | The app, coded against `HostTransport`                                                      | `HostTransport`, `LiveUpdate`, `TransportError`; drives `OrreryHandle`                             | `app/src/transport.ts`                                  |
| #12    | The editor side of `HostTransport`                                                          | `TransportRequest` in, `TransportMessage` out; uses `SourceAdapter`, `parseSession`, `buildReplay` | `app/src/transport.ts`                                  |
| #16    | The browser side of `HostTransport` (loopback server) and commands                          | `HostTransport` semantics over HTTP; uses the core functions                                       | `app/src/transport.ts`, `core/src/api.ts`               |
| #18    | `exportReplay: ExportReplay`, `validateReplay: ValidateReplay`                              | `ReplayModel`, `ExportOptions`, `ExportResult`; the v1 schema                                      | `core/src/api.ts`, `core/schema/replay-v1.schema.json`  |

Each implementing ticket exports a value of the given type, for example
`export const parseSession: ParseSession = async (input) => { ... }`, and re-exports it from the
package entry. `CoreApi` in `core/src/api.ts` lists the whole core surface.

Notes for implementers:

- #6: a transcript line whose `type` is not known is still a valid `RawLine`. Skip it and count
  it in `ParsedSession.lines.unknownByType`. Merge assistant lines by `message.id`: take the
  maximum of each usage field and the union of `tool_use` blocks by block id. Keeping only the
  first line per message id undercounts tool calls.
- #7: root resolution order is user setting, `CLAUDE_CONFIG_DIR`, per-OS default, opt-in extra
  roots, hook paths. A dropped file is always accepted (`resolvedBy: "dropped-file"`). The live
  registry is undocumented; treat it as optional and check that its process is alive.
- #8: agent ids in a replay are `main`, `a1`, `a2`, ... in the order of the parent `Agent` call
  (see [Agent ids](replay-format.md#agent-ids)). With `BuildReplayOptions.previous`, the
  [append-stability rules](replay-format.md#append-stability-live-view) must hold. `family` is the
  derived word even when the renderer does not know it. MCP tool names become `mcp:<server>`. The
  rules in [replay-format.md](replay-format.md#rules-the-schema-cannot-express) must hold.
- #10: the host owns the clock. The renderer never advances replay time on its own; the host
  calls `setTime` every frame while playing. `play`, `pause` and `setSpeed` only control motion
  that is not tied to replay time. `setModel` loads a different replay and clears selection and
  per-agent state; `updateModel` takes a newer snapshot of the same session and keeps both, keyed
  by agent id. Draw a `family` outside `KNOWN_MODEL_FAMILIES` as `unknown`.
- #11: follow a live session with `subscribe` only. Its first update is the current state, then
  each change; pass the first model to `setModel` and later ones to `updateModel`.
- #12 and #16: each `subscribe` call is its own subscription. In editor messages the `subscribe`
  request's `id` is the subscription id; `unsubscribe` takes `{ subscriptionId }`, and every `live`
  message carries `subscriptionId` as well as `key`. Build replays with the session replayer from
  `@orbitrace/core/node` (`createNodeSessionReplayer`, #75): `list` gives the session summaries,
  `load` a one-off replay, and `follow` the snapshots of a watched session, each built with the
  last one as `previous`. Its updates have the shape of `LiveUpdate`, and its errors carry a
  `TransportErrorCode` with a path-free message.
- #12 and #16: the HTTP route layout for the browser host is not defined yet. It is for #16 to
  define, carrying the same request and reply shapes as the editor messages.
- #18: Ajv is a dev dependency of core today (used only by the schema test). Export will need a
  validator at run time.

## Adding another agent runtime

Claude Code is the only runtime. To add one:

1. Add its id to `RuntimeId` in `core/src/model/sources.ts`.
2. Write a `SourceAdapter` for it that produces a `SessionInput`.
3. If its transcript lines differ from Claude Code's, give it a parser that returns a
   `ParsedSession`.

Nothing in the replay model, the renderer, the app or the transport refers to a specific runtime.

## Not built yet

At the end of ticket #2 the repository has the contract only: types, constants, the replay v1
schema, one synthetic replay fixture and tests for them. There is no parser, no source adapter,
no replay builder, no renderer, no transport implementation and no export. The app still shows a
placeholder page.
