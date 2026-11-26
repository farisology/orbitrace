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
- #12 and #16: the HTTP route layout for the browser host is defined in
  [Loopback server and routes](#loopback-server-and-routes-17) (lead's decision on #17). It
  carries the same request and reply shapes as the editor messages.
- #18: Ajv is a dev dependency of core today (used only by the schema test). Export will need a
  validator at run time.

## How the CLI ships the web app (#76)

Decision by the lead on #76: option (a). Implemented by #16.

- `npm run build` in `packages/cli` runs `tsc`, then `scripts/copy-app.mjs`, which copies the
  built web app (`packages/app/dist`, without its `types/` folder of declarations) into
  `packages/cli/dist/app`. An older copy is removed first. The script fails when
  `packages/app/dist/index.html` is missing, so a CLI build never ships without the app.
- `@orbitrace/app` stays a devDependency of the CLI. That is enough for
  `scripts/run-workspaces.mjs` to build the app before the CLI. The app does not need to be
  published or to export its build output.
- `files` in `packages/cli/package.json` is `dist`, so the one published package carries the app.
- At run time `appBundleDir()` (`packages/cli/src/app-bundle.ts`, compiled to
  `dist/app-bundle.js`) returns the `app/` folder beside it, or `null` when it holds no
  `index.html`. The loopback server (#17) serves from that folder. A test imports the built
  module and checks that it finds `index.html`.

Option (b), publishing `@orbitrace/app` with its assets as a runtime dependency and resolving
them with `import.meta.resolve`, was not chosen: it adds a second published package and an
export for static files.

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
  unsubscribe: the server stops following the session and stops its watch. While the Claude Code
  adapter has no `watchSession`, every stream is the current state followed by `ended`.
- A request the server refuses before there is a `TransportMessage` gets a non-200 status and the
  JSON body `{ "error": { "code": <TransportErrorCode>, "message": "…" } }`, with fixed,
  path-free messages:

| Status | Code           | When                                                                                                 |
| ------ | -------------- | ---------------------------------------------------------------------------------------------------- |
| 400    | `unsupported`  | Body is not JSON or not a valid request.                                                             |
| 401    | `unauthorized` | Missing or wrong `Authorization: Bearer <token>`.                                                    |
| 403    | `unauthorized` | Host header is not `127.0.0.1:<port>` or `localhost:<port>`, or the request comes from another page. |
| 404    | `not-found`    | No such file, or an `/api` path that is not a route.                                                 |
| 405    | `unsupported`  | Another method (including `OPTIONS`, so every CORS preflight is refused).                            |
| 409    | `unsupported`  | A live stream with that `id` is already open.                                                        |
| 413    | `unsupported`  | Body larger than 64 KiB.                                                                             |
| 415    | `unsupported`  | `Content-Type` is not `application/json` (optionally `; charset=utf-8`), or the body is encoded.     |
| 429    | `unsupported`  | 16 live streams are open already.                                                                    |
| 503    | `internal`     | The server is shutting down.                                                                         |

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
