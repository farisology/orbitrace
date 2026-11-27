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
| `scripts/release/version.mjs`       | Reads, checks and bumps the one shared version.                                                                 |
| `scripts/release/changelog.mjs`     | Checks `CHANGELOG.md`, prints the notes of one version, and moves Unreleased into a new version.                |
| `scripts/release/sync-licenses.mjs` | Copies the root `LICENSE` into core, renderer and cli.                                                          |
| `scripts/release/lib.mjs`           | The list of packed packages and their allow-lists, and shared helpers.                                          |
| `scripts/release/tools/`            | Pinned `@vscode/vsce` 4.1.1 and `ovsx` 1.4.0 with their own lockfile. Not a workspace. Both need Node.js 22.    |

The tests next to the scripts run in `npm test` at the root, so CI runs them on every pull request.
One of them packs the real core, renderer and cli tarballs and checks their contents, so a change
that ships a test, a fixture, a source map or a local path fails CI.

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

`pack-release.mjs` writes these files. Sizes are from a local run on 27 Nov 2026 at version
`0.0.0`; KiB is 1024 bytes.

| File                         | Packed    | Unpacked  | Files | Contents                                                                                                      |
| ---------------------------- | --------- | --------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `orbitrace-core-<v>.tgz`     | 95.3 KiB  | 420.3 KiB | 76    | `dist/**/*.js`, `dist/**/*.d.ts`, `schema/replay-v1.schema.json`, `README.md`, `LICENSE`, `package.json`      |
| `orbitrace-renderer-<v>.tgz` | 31.6 KiB  | 104.6 KiB | 33    | `dist/**/*.js`, `dist/**/*.d.ts`, `README.md`, `LICENSE`, `package.json`                                      |
| `orbitrace-<v>.tgz` (CLI)    | 179.4 KiB | 662.6 KiB | 89    | `dist/` with source maps and the web app in `dist/app`, `src/**/*.ts`, `README.md`, `LICENSE`, `package.json` |
| `orbitrace-vscode-<v>.vsix`  | 151.1 KiB | 600.9 KiB | 13    | `extension/dist/extension.js` (core bundled in), `extension/dist/app`, the icon, readme, licence              |
| `SHA256SUMS`                 |           |           |       | One `<sha256>  <file>` line per artefact. `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c`) checks them.      |
| `release-manifest.json`      |           |           |       | The version, the commit, and each artefact's size, SHA-256, file list, warnings and errors.                   |

Each tarball is checked for:

- every file matching the package's allow-list in `scripts/release/lib.mjs`, and no test,
  fixture, transcript (`*.jsonl`), build-info, `.env` or build-config file;
- `README.md`, a `LICENSE` identical to the root one, and every file `main`, `types`, `bin` and
  `exports` name;
- `repository` (with `directory`), `homepage`, `bugs`, `license: MIT` and a `files` allow-list
  in `package.json`, and workspace dependencies at the same version and not private;
- source maps: every map's sources are in the tarball (or embedded), and every
  `sourceMappingURL` comment points at a shipped map;
- the privacy rules of `scripts/privacy-check.mjs`, and the build machine's repository and home
  folder paths, in every text file. A finding names the file and the rule, never the text.

The `.vsix` gets the same checks with its own allow-list, plus its identity: a missing publisher
is a warning in a dry run and an error in a real release.

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

The CLI still builds with maps (its `tsconfig.build.json` belongs to the CLI ticket), so its
tarball ships `src/**/*.ts` beside them and every map resolves inside the tarball. When the CLI
turns its maps off or bundles core (see below), drop `src` from its `files` list and from its
allow-list.

## Try the artefacts

Download the `orbitrace-<version>` artefact from the run page (or build it locally, below), unzip
it into a folder outside the repository, and check the sums:

```sh
sha256sum -c SHA256SUMS        # macOS: shasum -a 256 -c SHA256SUMS
```

**The command line.** Install the core and CLI tarballs together into an empty project:

```sh
mkdir try-orbitrace && cd try-orbitrace && npm init -y
npm install <folder>/orbitrace-core-<v>.tgz <folder>/orbitrace-<v>.tgz
npx orbitrace --version
```

Installing the CLI tarball alone fails with `E404 ... '@orbitrace/core@<v>' could not be found`:
the CLI depends on `@orbitrace/core`, which is not on npm. See [Known gaps](#known-gaps).

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
     `@orbitrace/core`, and an installed CLI tarball would pull that package in (it asks the
     registry for `@orbitrace/core` today, see [Known gaps](#known-gaps)).
   - VS Code Marketplace: create the publisher (an Azure DevOps organisation is needed for the
     token).
   - Open VSX: sign in at open-vsx.org, accept the Eclipse Foundation publisher agreement, and
     create the namespace with the same id as the Marketplace publisher
     (`npx ovsx create-namespace <publisher> -p <token>`, or the pinned `ovsx` in
     `scripts/release/tools`).
2. **Set the publisher (#98)** in `packages/vscode/package.json`. Until then the `.vsix` installs
   as `undefined_publisher.orbitrace-vscode`, and changing it later breaks updates for anyone who
   installed the first one.
3. **Decide how the CLI gets core** and then remove `private: true` from `packages/cli` (#16).
   Today the CLI depends on `@orbitrace/core` at run time. Either publish core (it is already not
   private, and the renderer needs it published anyway) or bundle core into the CLI's `dist` with
   esbuild, as the extension does.
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

- **The CLI tarball does not install on its own.** `npm install orbitrace-<v>.tgz` in a clean
  project fails with `E404` for `@orbitrace/core@<v>`, because core is not on npm. With the core
  tarball installed alongside, `orbitrace --version`, `--help`, `list`, `export` and `open` work
  (checked on 27 Nov 2026 against a synthetic config folder from the fixtures generator). Fixed by
  owner step 3.
- **No extension publisher** (#98): see owner step 2.
- **`scripts/release/tools/package-lock.json` is not watched by Dependabot**, whose npm entry
  covers the root only.
- **The workflow has not run on GitHub yet.** The scripts it calls were run locally; the workflow
  file itself was only parsed and checked by tests.
