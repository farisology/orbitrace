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

[Unreleased]: https://github.com/farisology/orbitrace/commits/dev
