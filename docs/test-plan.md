# Test plan

What Orbitrace tests, how to run each check, what CI runs, what is not tested, and what a person
checks by hand before a release. Orbitrace is an independent project. It is not affiliated with
or endorsed by Anthropic.

**Status: nothing is released.** This page describes the repository as it is. The counts are
from a run on 27 Nov 2026 with Node.js 26 on macOS. They change with every pull request, so read
them as sizes, not as targets.

Every test uses invented data. No test reads your own Claude Code config folder: the tests that
start the `orbitrace` command or an editor point `HOME` and `CLAUDE_CONFIG_DIR` at a temporary
folder first.

## Run everything

From the repository root:

```sh
npm ci
npm run build
npm test
npm run lint
npm run typecheck
npm run format:check
npm run privacy
```

- `npm test` builds every package first, then runs each package's tests in dependency order, then
  the tests of the scripts under `scripts/`. It stops at the first package that fails.
- A package imports another package through its built `dist/` folder. After you change one
  package, build again before you test a package that depends on it.
- Use a Node.js version that `engines` in the root `package.json` allows.

## What each package tests

Each package runs its tests with Vitest: `npm test -w <name>`, after `npm run build` at the root.

| Package    | Run                               | Files | Tests | What the tests cover                                                                                                                                                                                                                                              |
| ---------- | --------------------------------- | ----- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`     | `npm test -w @orbitrace/core`     | 54    | 654   | The transcript parser, source resolution and session listing in temporary folders, file watching, the replay builder and event feed, live snapshots, export and the replay schema, the session replayer, the wire protocol checks, the ledger, the history store. |
| `fixtures` | `npm test -w @orbitrace/fixtures` | 17    | 1015  | The seeded generator writes the same bytes every time, the committed fixtures match it, each line fits core's raw-line contract, the golden replays match what core's pipeline makes today, and every fixture passes the repository's privacy check.              |
| `renderer` | `npm test -w @orbitrace/renderer` | 13    | 186   | Scene layout, level of detail, label layout, drawing on a fake canvas, per-frame allocation limits, colour contrast, hit testing, and that generated design files match the tokens.                                                                               |
| `app`      | `npm test -w @orbitrace/app`      | 48    | 582   | The React shell in happy-dom with a fake renderer: components, keyboard paths, follow live, export, the ledger panel, accessibility rules with axe-core, layout rules in the CSS, both client transports, the public player and its build, the built bundle.      |
| `cli`      | `npm test -w orbitrace`           | 24    | 315   | Argument parsing, `list`, `export`, `open` and `doctor`, the loopback server and its token, export privacy options, and the built command run as a child process.                                                                                                 |
| `vscode`   | `npm test -w orbitrace-vscode`    | 25    | 246   | The extension with a fake `vscode` module: commands, the Sessions view, panels, the page it writes for a tab and its Content-Security-Policy, the message host, the manifest, the build, and the helpers of the integration test.                                 |
| scripts    | `npx vitest run --dir scripts`    | 6     | 210   | The privacy check, the workspace runner and the release scripts. Two of these tests pack the real npm tarballs and install the real command-line tarball.                                                                                                         |

Run one file, or the tests whose name matches some text, from the package folder:

```sh
cd packages/app
npx vitest run test/App.test.tsx
npx vitest run test/App.test.tsx -t "reduced motion"
```

### Checks that cross packages

- **Parser and replay goldens.** `fixtures/replays/*.replay.json` is what core's pipeline makes of
  each synthetic session. A fixtures test runs the pipeline again and compares byte for byte.
- **The app and the command line.** `packages/app/test/e2e-http` starts the built `orbitrace`
  command as a child process and talks to its loopback server with the app's HTTP transport.
  Run only these with `npm run test:e2e-http -w @orbitrace/app`.
- **The app and the editor extension.** `@orbitrace/fixtures/wire` holds one conversation on the
  editor-tab wire: each request the app posts and what the extension answers. The app's test
  (`packages/app/test/webview-wire.test.ts`) and the extension's test
  (`packages/vscode/test/message-host.test.ts`) each check their real code against it. Neither
  test imports the other package's source.
- **The npm tarballs.** `scripts/release/check-package.test.mjs` packs core, renderer and the
  command line and checks every file against an allow-list.

### Tests that depend on timing

In the app's tests, React can run an effect in a later task than the commit that put the view in
the DOM. `findBy…` and `waitFor` return as soon as the DOM matches. A test that then reads
something an effect sets, such as the calls on the fake renderer, can read it too early. It
passes on an idle machine and fails now and then on a loaded one.

- After waiting for the DOM, await `rendererCreated(orrery)` from `packages/app/test/helpers.tsx`
  before reading the fake renderer's calls.
- To find such a test, widen the gap. This makes the fault fail every time:

  ```sh
  ORBITRACE_TEST_EFFECT_GAP_MS=30 npm test -w @orbitrace/app
  ```

Do not fix a test like this with a retry or a longer timeout. Wait for the thing the test reads.

## What CI runs

`.github/workflows/ci.yml` runs on every pull request into `dev` or `main` and on every push to
`dev`. All jobs run on `ubuntu-latest`. A failure in any step fails the run.

| Job                      | Node.js           | Steps                                                                                                                                                          |
| ------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy check            | `.nvmrc` (20.19)  | `npm run privacy` on the files, then `npm run privacy -- --range <base>..<head>` on the new commits. Nothing is installed.                                     |
| Build and test           | 20, 22, 24 and 26 | `npm ci --ignore-scripts`, `npm run build`, `node scripts/release/check-package.mjs`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`. |
| VS Code integration test | 22                | `npm ci --ignore-scripts`, `npm run build`, then the integration test under a virtual display with the current stable VS Code.                                 |

The matrix does not stop the other Node.js versions when one fails. The history store uses
`node:sqlite`, which Node.js 20 does not have; on Node.js 20 its tests check that core says so
and that the rest of core still works.

The release workflow (`.github/workflows/release.yml`) is started by hand. It repeats the build,
lint, typecheck, tests and privacy check, then packs and checks the artefacts. See
[releasing.md](releasing.md).

## The integration test in a real editor

```sh
npm run build
npm run test:integration -w orbitrace-vscode
```

It needs Node.js 22 or later and a display. It downloads VS Code the first time and starts it
with the built extension, a synthetic config folder and an empty home folder, all in a temporary
folder. It is not part of `npm test`.

It checks that the extension activates, that its commands exist, that the Sessions view lists the
synthetic sessions, that a session tab gets a page with the Content-Security-Policy, that the app
in the tab sends its first requests and gets answers, that nothing sent to the tab holds a path,
and that closing the tab stops its subscriptions.

It does not check what the tab draws: an extension cannot read a webview's pixels. The full list
and the settings are in
[packages/vscode/README.md](../packages/vscode/README.md#integration-test).

## The privacy check

```sh
npm run privacy
npm run privacy -- --range dev..HEAD
```

The first command scans every file and every file name in the tree. The second scans what the
commits in the range add, and their messages. A finding names the file, the line and the rule,
never the matched text. The check knows a fixed set of patterns, so passing it does not prove a
change is clean: also fill in the privacy checklist of the pull request template.

What an exported replay can hold is tested in core (`packages/core/test/export`) and audited in
[security/export-audit.md](security/export-audit.md).

## Release checks

These run from the repository root after `npm run build`.

```sh
node scripts/release/changelog.mjs check
node scripts/release/version.mjs current
node scripts/release/check-package.mjs
node scripts/release/install-check.mjs
```

- `changelog.mjs check` checks the format of `CHANGELOG.md`.
- `version.mjs current` prints the one version every package shares, and fails if they differ.
- `check-package.mjs` packs core, renderer and the command line into a temporary folder and
  checks each tarball: only allow-listed files, the licence, no source map that points nowhere,
  no private-looking text.
- `install-check.mjs` installs the command-line tarball alone into an empty project, offline, and
  runs `--version`, `--help`, `list`, `export` and `open --no-browser` on synthetic sessions.

`npm test` runs the last two as tests. To build every artefact, the `.vsix` included, with
Node.js 22 or later:

```sh
(cd scripts/release/tools && npm ci --ignore-scripts)
tmp="$(mktemp -d)"
out="$tmp/artefacts"
node scripts/release/pack-release.mjs --out "$out"
```

`--out` must be an empty folder outside the repository. The script writes the three tarballs, the
`.vsix`, `SHA256SUMS` and `release-manifest.json`, and fails if any artefact has an error. `tmp`
is the temporary folder this run made. It is the only folder to delete afterwards.

## Not tested

Known gaps. Each one is a risk a release carries until someone closes it.

- **What is drawn.** No test looks at pixels. The renderer's tests draw on a fake canvas and
  check the calls. The integration test cannot see inside the tab. There is no visual regression
  test.
- **Real browsers.** The app's tests run in happy-dom, not in a browser. Firefox, Safari and the
  VS Code webview are not part of any automated run. The headless Chrome checks in
  [packages/app/ACCESSIBILITY.md](../packages/app/ACCESSIBILITY.md#running-the-checks) and the
  browser benchmark are run by hand.
- **Windows and macOS in CI.** CI runs on Linux only. Paths, file watching and the editor are not
  tested on Windows or macOS there.
- **Screen readers.** The accessibility rules are checked by axe-core and by tests. What a
  person still has to check with a screen reader is listed in
  [ACCESSIBILITY.md](../packages/app/ACCESSIBILITY.md#still-to-check-with-a-screen-reader).
- **A real running session.** Follow live is tested with synthetic snapshots and a fake clock.
  No automated test follows a session that Claude Code is writing.
- **Other editors: Cursor and Windsurf.** Only VS Code is started. Cursor and Windsurf are built
  on it and ship their own Node.js. The unit tests, the integration test and the `.vsix` install
  have not been run in either of them.
- **A person looking at the extension in a real window.** Steps 5 to 8 of the checklist below
  (open a session, follow a live one, Export, the player) had not been done by a person when
  this plan was written. Only the commands of steps 3 and 4 were run: the install, and opening
  the window.
- **Installing the `.vsix`.** No automated test installs the packed extension. The integration
  test loads the extension from its folder. The checklist below covers the install.
- **The export button in an editor tab, end to end.** The save request and the extension's
  answer are tested on both sides, and the save dialog code is unit tested. No test clicks Export
  in a real tab and reads the saved file.
- **The demo tab in the editor.** It sends no messages, so the integration test cannot tell that
  its bundle runs.
- **The release workflow on GitHub.** Its scripts are tested. The workflow file has not run yet.
- **Publishing.** Every publish job is disabled.
- **Performance in CI.** The benchmarks are run by hand; the results are in
  [performance.md](performance.md). Allocation limits per frame are tested.
- **Large inputs in a browser.** A 50 MB file dropped into the page is not measured.
- **Code coverage.** No coverage number is collected.
- **Transcripts from a current Claude Code.** The parser is tested against synthetic fixtures
  written from the transcript shape known today, with some lines and blocks it does not know. No
  test reads a transcript a current Claude Code wrote, so a change in that shape is found only
  when someone notices it.

## Manual checklist for a release

Do this before a real release, on the artefacts of a dry run: the ones the release workflow
uploaded, or the ones you build in step 1. The editor steps use a new, empty VS Code profile in a
temporary folder, so your own extensions and settings are not touched. They need the `code`
command on your `PATH`.

The extension reads your own Claude Code sessions, so what you see in steps 5 to 7 is your own
data. Do not attach screenshots, recordings or replay files from it to an issue or a pull
request.

Run steps 1 to 10 in one terminal. The later steps use the variables `out`, `tmp` and `profile`
that the earlier steps set, and a new terminal does not have them.

1. **Build the artefacts.** Run the commands at the end of [Release checks](#release-checks).
   They set `tmp` and `out`. Every artefact must be listed without an error. For artefacts you
   downloaded instead, set only `out`, to the folder you unzipped them into. Do not set `tmp`.
2. **Check the sums.** In the artefacts folder:

   ```sh
   (cd "$out" && shasum -a 256 -c SHA256SUMS)
   ```

   On Linux use `sha256sum -c SHA256SUMS`.

3. **Install the `.vsix` into an empty profile.**

   ```sh
   profile="$(mktemp -d)"
   mkdir "$profile/workspace"
   code --user-data-dir "$profile/user" --extensions-dir "$profile/extensions" \
     --install-extension "$out"/orbitrace-vscode-0.0.0.vsix
   code --user-data-dir "$profile/user" --extensions-dir "$profile/extensions" --list-extensions
   ```

   Use the version you are releasing in the file name. The list must show one extension whose
   name ends in `orbitrace-vscode`, and no other.

4. **Open a new window on that profile.**

   ```sh
   code --user-data-dir "$profile/user" --extensions-dir "$profile/extensions" \
     --new-window "$profile/workspace"
   ```

   - The Orbitrace icon is in the activity bar.
   - The Extensions view lists "Orbitrace: Agent Session Visualizer" under Installed.

5. **Open a session.** Click the icon, then a session in the Sessions view.
   - A tab opens and the orrery plays. With reduced motion turned on in the system or in the
     editor, it stays paused until you press play.
   - Space pauses and plays. The arrow keys scrub. Clicking an agent fills the inspector.
   - With no sessions on the machine, **Open demo** shows the demo instead.
6. **Follow a live one.** Start a Claude Code session in a terminal, press Refresh in the Sessions
   view and open that session.
   - The badge in the header says `Live: working, following` or `Live: idle, following`.
   - New tool calls appear without a reload.
   - Scrub back: the badge says how far behind the view is. Press End: it follows again.
   - End the session: the badge changes to `Replay`.
7. **Export.** Press **Export** in the tab. Leave the three options off and save the file.
   - The editor's save dialog suggests `orbitrace.replay.json`.
   - Open the file in a text editor. It holds names, times and counts. It holds no prompt, reply,
     file path, command line or session id. Agent type names and MCP server names are kept: read
     them before you share the file.
   - Export again with **Opaque names** on. Names you chose, such as custom agent types and MCP
     server names, are replaced by numbered labels.
8. **Open the file in the player.**

   ```sh
   npm run build:player -w @orbitrace/app
   python3 -m http.server 8000 --bind 127.0.0.1 --directory packages/app/dist-player
   ```

   Open `http://127.0.0.1:8000/` and drop the exported file on the page.
   - The same agents and the same timeline show as in the editor tab.
   - A `.jsonl` transcript dropped on the page is refused with a message.
   - The browser's network panel shows requests to the page's own address only.
   - Stop the server with Ctrl+C.

9. **Try the command line from its tarball.** `install-check.mjs` already did this on synthetic
   sessions. To see it yourself, follow
   [Try the artefacts](releasing.md#try-the-artefacts).
10. **Clean up.** Close the window from step 4 and delete the profile folder from step 3:

    ```sh
    rm -rf "${profile:?}"
    ```

    If you built the artefacts in step 1, also delete the temporary folder they are in:

    ```sh
    rm -rf "${tmp:?}"
    ```

    For artefacts you downloaded, delete only `$profile`. The folder you unzipped them into is
    yours, and so is the folder above it: neither command touches them. `${name:?}` stops the
    command with an error when the variable is empty or not set, for example in a new terminal.

Write down what you checked, on which operating system and VS Code version, in the release pull
request. If a step fails, open an issue with an invented example, not with your own data.
