# Releasing

How Orbitrace is packaged and released: the release workflow, what each artefact contains, the
version and changelog rules, and the one-time steps the owner takes before anything is published.
Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.

**Status: nothing is published.** The workflow builds and checks installable artefacts and
uploads them to the workflow run. Every publish job in it is disabled. There is no package on npm
and no extension on the VS Code Marketplace or Open VSX, so searching for Orbitrace in the
Extensions view finds nothing; a `.vsix` you install by hand shows under **Installed** (see
[Try the artefacts](#try-the-artefacts)).

## The pieces

| Path                                | What it does                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/release.yml`     | The release workflow. Started by hand only.                                                                     |
| `scripts/release/preflight.mjs`     | First step of a run: checks the inputs, the versions, the changelog and, for a real release, the tag.           |
| `scripts/release/pack-release.mjs`  | Packs the three npm tarballs and the `.vsix`, checks each one, writes `SHA256SUMS` and `release-manifest.json`. |
| `scripts/release/check-package.mjs` | Packs core, renderer and cli into a temporary folder and checks each tarball against its allow-list.            |
| `scripts/release/install-check.mjs` | Installs the CLI tarball alone into an empty project and runs it against synthetic sessions.                    |
| `scripts/release/version.mjs`       | Reads, checks and bumps the one shared version.                                                                 |
| `scripts/release/changelog.mjs`     | Checks `CHANGELOG.md`, prints the notes of one version, and moves Unreleased into a new version.                |
| `scripts/release/sync-licenses.mjs` | Copies the root `LICENSE` into core, renderer and cli.                                                          |
| `scripts/release/lib.mjs`           | The list of packed packages and their allow-lists, and shared helpers.                                          |
| `scripts/release/tools/`            | Pinned `@vscode/vsce` 4.1.1 and `ovsx` 1.4.0 with their own lockfile. Not a workspace. Both need Node.js 22.    |

The tests next to the scripts run in `npm test` at the root, so CI runs them on every pull request,
on Node 20, 22, 24 and 26. Node 20 is past its end of life (April 2026) but stays in `engines` and
in CI for now, by the owner's decision on #174. Nothing in the build, the tests or the built viewer
needs a newer line: CI builds and tests the whole repository on Node 20. `.nvmrc` (20.19) and the
CLI's `engines` (`>=20`) stay as they are.
One of the tests packs the real core, renderer and cli tarballs and checks their contents, so a change
that ships a test, a fixture, a source map or a local path fails CI. Another installs the real CLI
tarball alone and runs it (a few seconds; see [Try the artefacts](#try-the-artefacts)).

## The release workflow

It runs only when someone with write access starts it in **Actions > Release > Run workflow**.
There is no push, tag, schedule or pull request trigger. GitHub shows that button only for a
workflow file on the default branch (`main`), so the workflow can be run once this file has
reached `main`. You then choose the branch or tag to run it from.

Inputs:

| Input     | Default | Meaning                                                                                                        |
| --------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `version` | none    | The version, without a leading `v`, for example `0.1.0`. Every `packages/*/package.json` must already have it. |
| `dry_run` | ticked  | Build, check and upload only. Untick only for a real release, run from the `v<version>` tag.                   |

Jobs:

1. **Check, build and package** (every run, read-only token). Preflight, then the same install
   and checks as CI (`npm ci --ignore-scripts`, build, lint, typecheck, test, privacy), then
   `pack-release.mjs`. It uploads one workflow artefact, `orbitrace-<version>`, kept for 30
   days, and writes a table of the files, sizes and SHA-256 sums on the run page.
2. **Create a draft GitHub Release** (only when `dry_run` is unticked). Checks the sums, takes the
   notes from the version's `CHANGELOG.md` section, and creates a draft release for the existing
   `v<version>` tag with the artefacts attached. It fails if the tag does not exist, so it never
   creates one, and the draft stays invisible until the owner publishes it by hand. This is the
   only job with `contents: write`.
3. **Publish to npm, to the VS Code Marketplace, to Open VSX** (disabled). See
   [Turning on publishing](#turning-on-publishing).

### What stops an accidental publish

| Gate                                                                                                        | Where                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Only a manual start by someone with write access                                                            | `on: workflow_dispatch` only          |
| `dry_run` is ticked by default                                                                              | workflow input                        |
| Anything but `DRY_RUN=false` is a dry run                                                                   | `preflight.mjs`                       |
| A real release must run from the `v<version>` tag, with a `CHANGELOG.md` section and an extension publisher | `preflight.mjs`                       |
| Every publish job starts with `if: ${{ false && ... }}`                                                     | `release.yml`; a test checks it       |
| Each publish job runs in its own GitHub environment and fails if its secret is missing                      | `release.yml`                         |
| `publishConfig.provenance: true` makes `npm publish` fail outside a supported CI                            | core, renderer and cli `package.json` |
| `orbitrace` (the CLI) is `private: true`                                                                    | `packages/cli/package.json` (#16)     |

## Artefacts

`pack-release.mjs` writes these files. Sizes are from a local run of
`node scripts/release/pack-release.mjs` (with the `.vsix`) on 27 Nov 2026 on `dev` at `e78bb38`
(after #25, #26, #31, #168 and #22) with the docs changes of #183 to #187, version `0.0.0`, taken
from its `release-manifest.json` (the manifest has no unpacked size for the `.vsix`, so that cell
is the sum of its file sizes); KiB is 1024 bytes. The CLI tarball and the `.vsix` include the web
app's `THIRD-PARTY-NOTICES.txt` and `third-party-modules.json` (#143).

| File                         | Packed    | Unpacked  | Files | Contents                                                                                                                                                                                                        |
| ---------------------------- | --------- | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orbitrace-core-<v>.tgz`     | 155.8 KiB | 617.6 KiB | 116   | `dist/**/*.js`, `dist/**/*.d.ts`, `schema/replay-v1.schema.json`, `README.md`, `LICENSE`, `package.json`                                                                                                        |
| `orbitrace-renderer-<v>.tgz` | 57.6 KiB  | 191.5 KiB | 41    | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md`, `LICENSE`, `package.json`                                                                                                                                        |
| `orbitrace-<v>.tgz` (CLI)    | 188.9 KiB | 747.8 KiB | 12    | `dist/index.js` (core bundled in), the web app, its notices and module list in `dist/app`, `README.md`, `LICENSE`, `package.json`                                                                               |
| `orbitrace-vscode-<v>.vsix`  | 192.9 KiB | 713.8 KiB | 16    | `extension/dist/extension.js` (core bundled in), `extension/dist/app` with notices and module list, the activity-bar icon, the listing icon `extension/media/icon.png` (256x256 PNG, 11.9 KiB), readme, licence |
| `SHA256SUMS`                 |           |           |       | One `<sha256>  <file>` line per artefact. `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c`) checks them.                                                                                                        |
| `release-manifest.json`      |           |           |       | The version, the commit, and each artefact's size, SHA-256, file list, warnings and errors.                                                                                                                     |

Each tarball is checked for:

- every file matching the package's allow-list in `scripts/release/lib.mjs`, and no test,
  fixture, transcript (`*.jsonl`), build-info, `.env` or build-config file;
- `README.md`, a `LICENSE` identical to the root one, and every file `main`, `types`, `bin` and
  `exports` name;
- `repository` (with `directory`), `homepage`, `bugs`, `license: MIT` and a `files` allow-list
  in `package.json`, and workspace dependencies at the same version and not private;
- source maps: every map's sources are in the tarball (or embedded), and every
  `sourceMappingURL` comment points at a shipped map;
- every `bin` file starts with `#!/usr/bin/env node` and is executable;
- for the CLI (`selfContained` in `lib.mjs`): no `dependencies`, `peerDependencies` or
  `optionalDependencies`, and `dist/index.js` imports only Node.js built-ins and shipped files;
- where it carries the web app (an `index.html` with `assets/*.js` beside it):
  `THIRD-PARTY-NOTICES.txt` and `third-party-modules.json` in the same folder, every script listed
  in the module list, and notices that name exactly the packages the list puts in those scripts
  (see [Third-party notices](#third-party-notices));
- the privacy rules of `scripts/privacy-check.mjs`, and the build machine's repository and home
  folder paths, in every text file. A finding names the file and the rule, never the text.

The `.vsix` gets the same checks with its own allow-list, plus its identity: a missing publisher
is a warning in a dry run and an error in a real release.

`pack-release.mjs` then installs the CLI tarball alone with `scripts/release/install-check.mjs`
(see [Try the artefacts](#try-the-artefacts)); a failure there is an error of that artefact.

### Source maps

Core and renderer ship **no source maps**: `sourceMap` and `declarationMap` are off in their
`tsconfig.build.json`, and their `files` lists exclude `*.map` so a stale map in a local `dist/`
cannot slip in. Why: the maps pointed at `src/`, which the tarballs do not ship, so they were
broken links that bundlers warn about; `tsc` output at ES2022 reads almost line for line like the
source; and the source of every release is public at its tag. It also cut the core tarball from
133 KiB to 95 KiB. Embedding the sources in the maps would have fixed the links for the `.js`
maps but not for the declaration maps, and would have roughly doubled the tarball for little use.
Inside the repository, go to definition on an `@orbitrace/core` import now lands in the `.d.ts`
file instead of the `.ts` source.

The CLI ships no source maps either, and no `src/` (#120). `packages/cli/scripts/build.mjs`
bundles the command and `@orbitrace/core` (both its main and its `/node` entry) with esbuild into
one ES module, `dist/index.js`, for Node.js 20 or later, with Node built-ins left external and no
map. It writes no type declarations: they would import `@orbitrace/core`, which is not installed
with the CLI. The build fails if code from a third-party package ends up in the bundle, so a new
bundled dependency cannot ship before its licence is noted in `NOTICE`; today the bundle holds
only Orbitrace's own code. The CLI tarball went from 183.6 KiB packed, 675.9 KiB unpacked and
89 files to 158.0 KiB, 633.9 KiB and 10 files (local runs on 27 Nov 2026).

### Third-party notices

The web app bundle contains third-party code (React, React DOM and scheduler, plus small helpers
from Vite and its bundler, Rolldown), and it is copied into the CLI tarball, the `.vsix` and the
public player (#143). When the app is built, `packages/app/scripts/third-party-notices.mjs`, a
Vite plugin with no dependency, reads the modules the bundler actually put into each output
chunk and writes `THIRD-PARTY-NOTICES.txt` next to `index.html` in `dist/` and `dist-player/`:
each package's name, version, licence and the full text of the licence file(s) in its installed
folder, sorted by name, plus a one-line note that core's replay validator is code generated by
Ajv with no Ajv module in it. The build fails when a bundled package declares no licence, has no
licence file, or has a licence outside the allow-list (`0BSD`, `Apache-2.0`, `BSD-2-Clause`,
`BSD-3-Clause`, `ISC`, `MIT`; today every bundled package is `MIT`). The app build also writes
`dist/third-party-modules.json`, which packages are in which chunk. The CLI and extension builds
copy both files with the app and fail when the app's scripts have no notices beside them, and
the release check compares the notices with the module list in each artefact, so a missing,
stale or hand-edited notices file fails it. The CLI's and extension's own esbuild bundles hold
only Orbitrace's code: both builds fail when esbuild's metafile lists an input from
`node_modules`.

## Try the artefacts

Download the `orbitrace-<version>` artefact from the run page (or build it locally, below), unzip
it into a folder outside the repository, and check the sums:

```sh
sha256sum -c SHA256SUMS        # macOS: shasum -a 256 -c SHA256SUMS
```

**The command line.** The CLI tarball installs on its own: core is bundled into it, so it has no
dependencies and npm fetches nothing.

```sh
mkdir try-orbitrace && cd try-orbitrace && npm init -y
npm install <folder>/orbitrace-<v>.tgz
npx orbitrace --version
```

`scripts/release/install-check.mjs` does the same automatically: it installs the tarball alone
with `npm install --offline` into an empty temporary project, checks that nothing else was
installed, and runs `orbitrace --version`, `--help`, `list --json`, `export --latest -o <file>`
and `open --no-browser --json` through the installed bin link. HOME, `CLAUDE_CONFIG_DIR` and
npm's cache point into the temporary folder before the first command, and the config folder holds
only sessions from the fixtures generator, so your own sessions are never read. Run it with
`node scripts/release/install-check.mjs` after `npm run build` (it packs `packages/cli` itself,
or takes `--tarball <file>`); `npm test` runs it through `scripts/release/install-check.test.mjs`,
and `pack-release.mjs` runs it on the tarball it writes.

**The extension.**

```sh
code --install-extension <folder>/orbitrace-vscode-<v>.vsix
```

or **Extensions: Install from VSIX...** in the Command Palette. It is listed under **Installed**
as "Orbitrace: Agent Session Visualizer" (filter with `@installed orbitrace`). Until the
publisher is set (#98), VS Code installs it as `undefined_publisher.orbitrace-vscode`.

### A local dry run

The same packaging without GitHub, from the repository root, with Node.js 22 or later:

```sh
npm ci
(cd scripts/release/tools && npm ci --ignore-scripts)
npm run build
node scripts/release/check-package.mjs              # the three tarballs: file lists and sizes
node scripts/release/pack-release.mjs --out "$(mktemp -d)/artefacts"
```

`--out` must be outside the repository and empty. Add `--skip-vsix` to leave out the extension
(no vsce needed), and `--version <v>` to check the version.

## Versions

- **One version for every package** under `packages/`, published or not, for now. Dependencies
  between workspace packages are pinned to that exact version. `version.mjs check <v>` and the
  preflight enforce both. The root `package.json` is the private monorepo root and is never
  released.
- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor bump
  (`0.x.0`) may break things and a patch bump (`0.x.y`) does not. The replay format has its own
  `formatVersion` ([replay-format.md](replay-format.md)); a change to it is at least a minor bump.
- Tags are `v<version>`, for example `v0.1.0`.
- npm takes a pre-release such as `1.0.0-rc.1`; the VS Code Marketplace does not take a
  pre-release suffix. Release the extension from plain `x.y.z` versions.
- `0.0.0` means unreleased. The preflight refuses a real release of `0.0.0`.

### Cutting a release

1. On a branch from `dev` (for example `chore/release-0.1.0`):

   ```sh
   node scripts/release/version.mjs bump 0.1.0
   npm install --package-lock-only --ignore-scripts
   node scripts/release/changelog.mjs release 0.1.0
   ```

   `bump` sets the version in every `packages/*/package.json` and in the dependencies between
   them. `npm install --package-lock-only` records them in `package-lock.json`. `release` moves
   the Unreleased entries into a `0.1.0` section dated today and updates the links at the bottom.

2. Open a pull request into `dev`. CI runs as usual.
3. The owner merges `dev` into `main`, tags the merge commit on `main` with `v0.1.0`, and pushes
   the tag.
4. Run the workflow from the tag with `dry_run` ticked. Download the artefacts and try them.
5. Run it again from the tag with `dry_run` unticked. This creates the draft GitHub Release, and,
   once publishing is turned on, publishes.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

- `## [Unreleased]` is always the first section. Released versions follow, newest first, as
  `## [x.y.z] - YYYY-MM-DD`.
- Entries go under `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` or
  `### Security`, and no other heading.
- A pull request that changes what a user sees adds one line under Unreleased, written for
  users, with the issue and pull request numbers, for example `(#20, #111)`.
- The same privacy rules as the rest of the repository: no transcript content, local paths,
  private project names, session ids, emails or secrets.
- `node scripts/release/changelog.mjs check` checks the format; the release workflow runs it, and
  for a real release requires a non-empty section for the version. That section becomes the
  release notes.

## Before the first real release: owner steps

None of these can be done from the repository. Each is a one-time step.

1. **Reserve the names (#35).**
   - npm: the unscoped name `orbitrace`, and the `@orbitrace` scope, by creating an npm
     organisation named `orbitrace`. Do the scope first: the registry answered "Scope not
     found" for `@orbitrace` on 27 Nov 2026, so until it is held anyone can claim it and publish
     `@orbitrace/core`, and anything that installs `@orbitrace/renderer` from npm would pull
     that package in. The CLI no longer asks the registry for it: core is bundled into the CLI
     (#120).
   - VS Code Marketplace: create the publisher (an Azure DevOps organisation is needed for the
     token).
   - Open VSX: sign in at open-vsx.org, accept the Eclipse Foundation publisher agreement, and
     create the namespace with the same id as the Marketplace publisher
     (`npx ovsx create-namespace <publisher> -p <token>`, or the pinned `ovsx` in
     `scripts/release/tools`). What the listing is built from, and what Open VSX needs beyond the
     Marketplace, is in
     [Listing metadata](../packages/vscode/README.md#listing-metadata).
2. **Set the publisher (#98)** in `packages/vscode/package.json`. Until then the `.vsix` installs
   as `undefined_publisher.orbitrace-vscode`, and changing it later breaks updates for anyone who
   installed the first one.
3. **Remove `private: true` from `packages/cli`** (#16) when the CLI is to be published. How
   the CLI gets core is decided: it is bundled into the CLI's `dist/index.js` with esbuild, as
   the extension does (#120), so publishing the CLI does not need core on npm. The renderer
   still imports core at run time, so core must be published before the renderer is.
4. **Create three GitHub environments** in Settings > Environments: `npm`,
   `vscode-marketplace` and `open-vsx`. In each, add yourself as a required reviewer and limit
   deployments to tags matching `v*`. Put each secret in its environment, not in the repository
   secrets, so only that job can read it.
5. **Add the secrets** (next section).
6. **Turn on publishing** (below).

### Secrets

| Secret      | Environment          | What it is                                                                                                                                                                                                                  |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | `npm`                | An npm granular access token with read and write access to `@orbitrace/core`, `@orbitrace/renderer` and `orbitrace` only. npm limits how long a write token lives; check npm's current rules and renew it before a release. |
| `VSCE_PAT`  | `vscode-marketplace` | An Azure DevOps personal access token for the publisher, with the Marketplace (Manage) scope and access to all accessible organisations.                                                                                    |
| `OVSX_PAT`  | `open-vsx`           | An Open VSX access token, created in the open-vsx.org user settings.                                                                                                                                                        |

The draft release uses the built-in `GITHUB_TOKEN` with `contents: write` in that job only. No
other secret is used, and the dry run uses none.

npm also supports trusted publishing from GitHub Actions (OpenID Connect, no stored token). It is
the better long-term choice; switching to it means configuring each package on npmjs.com and
replacing the `NPM_TOKEN` gate in the npm job. That is a follow-up, not done here.

### Turning on publishing

A reviewed pull request removes `false &&` from the `if` of the publish job (or jobs) to turn
on, and updates the test in `scripts/release/pack-release.test.mjs` that checks they are
disabled. After that a job still runs only when `dry_run` is unticked, after the draft release,
when its environment's reviewer approves it, and when its secret is set. Each job publishes the
uploaded artefacts after checking their sums; nothing is rebuilt. The npm job publishes core
first, skips a private package with a warning, and skips a version already on npm, so a re-run
after a partial publish finishes the rest.

## Known gaps

- **No extension publisher** (#98): see owner step 2.
- **The workflow has not run on GitHub yet.** The scripts it calls were run locally; the workflow
  file itself was only parsed and checked by tests.
