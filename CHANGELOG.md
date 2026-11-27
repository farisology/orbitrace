# Changelog

All notable changes to Orbitrace are recorded in this file. The format is based on
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the packages follow
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Every package under
`packages/` shares one version. How to add an entry and how to cut a release is in
[docs/releasing.md](docs/releasing.md).

Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

## [Unreleased]

Nothing has been released yet. This section lists what exists on `dev`, from the pull requests
merged so far.

### Added

- Replay format v1: the event model and the replay contract in `@orbitrace/core`, with a JSON
  Schema for replay files (#2, #49).
- `@orbitrace/core`: a Claude Code transcript parser (#6, #53); source resolution and session
  listing (#7, #59); the replay model builder and the event feed (#8, #60); structure-only replay
  export with schema validation (#18, #54); a shared session replayer and `toRealSeconds` (#75,
  #80); `watchSession` for live updates (#74, #88), with a settle check for gaps in file watching
  (#99, #101); one host protocol and one set of display formatters shared by every host (#96,
  #104).
- `@orbitrace/renderer`: a framework-free Canvas 2D orrery engine, with a demo page and
  benchmarks (#10, #61).
- Web app (`@orbitrace/app`): a React shell with the orrery, inspector, timeline, controls and
  event feed (#11, #83), and transports for an editor tab and for HTTP, chosen at start-up (#85,
  #89).
- `orbitrace` command line: `list` and `export` with JSON output and stable exit codes (#16,
  #82), and `open`, which shows a session in the browser through a loopback server (#17, #91).
- VS Code extension: a Sessions view in the activity bar and one editor tab per session (#12,
  #90), and an integration test that runs it in a real VS Code window (#102, #105).
- Synthetic transcript fixtures with a seeded generator (#9, #55), and golden replays made by the
  same pipeline as an export (#73, #79).
- CI on Node 20 and 22 with a privacy check of the files and of every new commit (#3, #48).
- The npm workspaces monorepo (#1, #45), design tokens and identity assets (#5, #46),
  contributor and agent documentation (#4, #44), trademark and licence notes (#40, #43), a
  storage spike for the history index (#24, #47), and documentation for everything merged so
  far (#62, #103).
- A manual release workflow that builds and checks the npm tarballs and the `.vsix` and uploads
  them with their SHA-256 sums; it publishes nothing (#20). Each npm package now ships a README,
  the licence and repository links (#110).
- Web app: follow a running session. A session the host lists as running opens at its newest
  moment and keeps up as it grows. Scrubbing, Home or Pause leaves follow; the Go live button or
  the End key returns to it. The Live badge says "following" or how far behind the view is
  (#127, #133).
- Web app: an accessibility pass for WCAG 2.1 AA. Screen readers get a hidden table of the agents
  and a polite live region; failures, selection and tool kinds no longer rely on colour alone;
  focus outlines show in editor tabs; the layout reflows at narrow widths and 200% zoom. The audit
  is in `packages/app/ACCESSIBILITY.md` (#13, #116).
- `@orbitrace/renderer`: a frame-time budget with level of detail (full up to 100 agents, reduced
  up to 250, minimal above that with finished waves collapsed), and a label layout in which labels
  never overlap and the selected and hovered agents always keep theirs. New `bench:node`
  benchmarks and settings for `bench:browser`; the results are in `docs/performance.md` (#14,
  #115).
- The web app ships a `THIRD-PARTY-NOTICES.txt`, with the licence of each bundled package, in the
  CLI tarball, the `.vsix` and the public player; the release check fails when it is missing or
  stale (#143).
- `@orbitrace/core/node`: a history store and incremental indexer on `node:sqlite` (Node 22.13+;
  unavailable with a reason on Node 20): idempotent, redacting ingest by byte offset, one writer
  with a pid lock, a worker-thread entry, and deletion of a session or the whole store. Opt-in;
  no host calls it yet (#25).
- `@orbitrace/core`: `toCompressedSeconds`, the inverse of `toRealSeconds`. The app imports it
  from core and no longer keeps its own copy (#135, #147).
- A public replay player: a static page, built with `npm run build:player -w @orbitrace/app`
  into `packages/app/dist-player`. It opens a `.replay.json` file or the bundled demo in the
  browser, and a replay on its own origin from a `?replay=` link. It refuses links to other
  origins, files that fail the schema and files over 50 MB, and makes no request to another
  origin (its Content-Security-Policy enforces this). A workflow that runs only when started by
  hand uploads the page as a GitHub Pages artefact; it does not deploy it. See `docs/player.md`
  (#19, #148).
- `orbitrace doctor`: a read-only check of the set-up (Node version, config folder, session folders, parser health, running-sessions folder, web app, loopback port, `node:sqlite`) with a stable code, a status and an exact fix per check, `--json` and exit code 12 when a check fails; see `docs/cli.md` (#31).
- Ledger: `sessionLedger` in `@orbitrace/core` totals one session's tokens in four classes and estimates their cost at Anthropic's list prices (read 27 Nov 2026), per model and per agent, with unpriced models marked and never guessed; the inspector shows it, every cost labelled an estimate. See `docs/ledger.md` (#26).
- Web app: an Export button and dialog that write the replay on screen with core's
  `exportReplay`, with the opt-in opaque names, rounded times and bucketed tokens, all off; a
  browser downloads the file and an editor tab saves it through the editor's save dialog. The
  playhead no longer adds a horizontal scrollbar at the live edge, and a replay that is not live
  gives its dock the height of its lanes (#168, #172).
- VS Code extension: listing text for the VS Code Marketplace and Open VSX (description,
  keywords, category, a 256x256 icon drawn from the Orbitrace mark, banner colour, and a readme
  written as the listing page); nothing is published (#22).
- Ledger: prices cache writes at their own 5-minute and 1-hour prices and each reply at its own model when the in-memory model records them (`buildReplay` option `replyDetails`, new optional `ReplayReplyDetails`), and otherwise falls back to the 5-minute price and the agent's model with a note in the inspector; replay files, the schema and every golden replay are unchanged (#191, #190).

### Changed

- The privacy check scans file and folder names as well as file contents. Its `--range` mode
  warns about author and committer emails that are not noreply addresses (`--strict-authors`
  makes them failures), and extra patterns can come from `.privacy-denylist.local` or
  `ORBITRACE_PRIVACY_DENYLIST`. CI runs the VS Code integration test in a job that does not block
  a merge yet (#57, #112).
- The app's session picker and the extension's Sessions view format relative times with one
  shared function, `formatAgo` from `@orbitrace/core`, and the extension builds its host meta tags
  from core's constants. A new test runs the app's HTTP transport against the built CLI (#129,
  #131).
- `@orbitrace/core`: `npm run typecheck` now enforces the browser/Node split.
  `tsconfig.browser.json` checks the main entry without Node's types, so a browser-side file that
  uses `process`, `Buffer` or a `node:` import, or imports a `./node` file, fails the check;
  `tsconfig.json` checks the `./node` entry and the tests. CI clean-ups in the same change: a
  named step that checks the npm packages, Dependabot updates for `scripts/release/tools` (#121),
  no separate cache-folder step before the VS Code integration test (#125), and the extension's
  tests take their tag text from core's constants (#107) (#72, #146).
- CI: the formatting check and the VS Code integration test now fail the build. The whole tree
  passes `npm run format:check`; the generated `design/tokens.css` and the generated contrast
  tables in `design/identity.md` are left to their generator (#50).
- CI builds and tests on Node 24 and 26 as well as 20 and 22; docs catch-up for the allocation
  test, opaque-name replays, third-party notices and the release gaps (#174, #165, #166, #169,
  #170, #173).

### Fixed

- `@orbitrace/renderer`: wave labels sit on their own ring, clear of nodes, arcs, beams and tags.
  Every canvas label is drawn on a backing box that keeps its text at 4.5:1 or more over anything
  behind it. Flashes start at least 0.35 s apart, so no more than three fall in one second (#128,
  #117, #118, #134).
- The CLI tarball installs on its own: `@orbitrace/core` is bundled into its `dist/index.js`, and
  it no longer ships `src/`, source maps or type declarations (#120, #132).
- Web app polish (#144): the orrery keeps its size while a followed session adds timeline lanes (the lanes scroll in a fixed-height dock, the newest shown while following); the empty event feed says "Press play." only while paused (#159); message pages are centred (#154); losing a followed session's status is announced once (#139); the public player opens replay files only and refuses transcripts (#19).
- Follow live ends when a followed session's process exits without changing a file. While the
  session is busy or idle, core's `watchSession` reads the live registry again every
  `livenessIntervalMs` (5 s by default) and reports `ended` once the process is gone. The app
  also stops following, and hides Go live, when the status becomes unknown (#139, #147).

### Security

- A replay replaces an agent type, tool name or MCP server name that is not a plain identifier
  with a fixed label (`subagent`, `unknown`, `mcp:unknown`), so free text in such a name cannot
  reach a shared replay. The audit of the export path is in `docs/security/export-audit.md` (#23,
  #114).
- Opt-in export options: `--opaque-names` (`ExportOptions.names: "opaque"`) writes agent types,
  MCP servers, non-built-in tool names and unknown model ids as numbered labels, and
  `--round-times` and `--bucket-tokens` coarsen times and token counts; the default export is
  unchanged (#122, #123).

[Unreleased]: https://github.com/farisology/orbitrace/commits/dev
