# @orbitrace/fixtures

A seeded generator of synthetic Claude Code transcripts, the paths of the generated files in
`fixtures/` at the repository root, and the golden replay files made from them. Private to
this repository: it is used by the tests of the other packages and supplies the demo session.

Everything it writes is invented. No text, path, project name or id comes from a real
session.

## Use in a test

```ts
import { readFileSync } from "node:fs";
import { fixturePaths, FIXTURE_CONFIG_DIR, FIXTURE_MANIFEST_PATH } from "@orbitrace/fixtures";

const paths = fixturePaths("two-waves");
paths.transcript; // absolute path of the main transcript
paths.subagents; // [{ agentId, agentType, transcript, meta }]
FIXTURE_CONFIG_DIR; // a folder laid out like a Claude Code config folder

const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST_PATH, "utf8"));
manifest.sessions[1].expected.totals.toolCalls; // what is true of the session
```

Add `"@orbitrace/fixtures": "0.0.0"` to the `devDependencies` of the package that needs it.

This package depends on `@orbitrace/core` for the raw-line contract (see
[The contract](#the-contract)) and for the replay pipeline that writes the golden replay
files. So `@orbitrace/core` itself cannot list this package: the two
would depend on each other, and `scripts/run-workspaces.mjs` stops on a dependency cycle.
Tests inside `core` read the committed files instead: `fixtures/manifest.json` lists every
session with the paths of its files and what is true of it.

To get a session in memory instead of from disk:

```ts
import { generateSession } from "@orbitrace/fixtures/generator";

const session = generateSession("demo"); // or generateSession("demo", { seed: "mine" })
session.files; // [{ path, content }] relative to the config folder
session.expected; // facts: agents, totals, waves, idle gaps
```

`@orbitrace/fixtures/generator` has no Node dependency, so it also runs in a browser. Its
only import from outside this package is `@orbitrace/core`, which has no Node import today; a
test fails if that changes. The package entry adds the paths, the functions that write and
check the folder, and the golden replay files.

Each subagent of a generated session carries its meta file as an object
(`session.subagents[n].meta`, a `RawSubagentMeta`), next to the paths of its files.

## The contract

The raw line vocabulary is defined once, in `@orbitrace/core` (`src/model/raw.ts`). This
package imports it and re-exports it, and defines none of it a second time:

- `KNOWN_RAW_LINE_TYPES`, `KNOWN_EFFORT_LEVELS` and the types `KnownRawLineType`,
  `KnownEffortLevel`, `RawLine`, `RawSubagentMeta`, `RawUsage` and `RawCacheCreation` are the
  contract's own.
- `FullUsage` is `RawUsage` with every token count present, which is what the generator
  writes. It is derived from `RawUsage`, not written out again. `FullCacheCreation` is the same
  for `RawCacheCreation` (#191).
- `COMMON_LINE_KEYS`, `USAGE_KEYS` and `SUBAGENT_META_KEYS` are run-time lists of the keys that
  `RawLineBase`, `RawUsage` and `RawSubagentMeta` declare (`USAGE_KEYS` holds the counts;
  `USAGE_SPLIT_KEY` is `cache_creation`, whose keys are `CACHE_CREATION_KEYS`). The contract has
  types but no such lists, and the tests need them. `npm run typecheck` fails when a list and its
  type differ.
- `CONVERSATION_LINE_TYPES` names the known line types that carry the common keys.
  `HOUSEKEEPING_LINE_TYPES` is every other known type, computed from the contract's list.

Only these are this package's own: the `INVENTED_*` values, `MODELS` and
`BUILT_IN_AGENT_TYPES`.

`test/contract.test.ts` holds the checks: a generated line is a `RawLine`, a generated meta
object is a `RawSubagentMeta`, a generated session fits `SessionInput`, every line type in the
fixtures that is not invented is in `KNOWN_RAW_LINE_TYPES`, and every invented one is not.

## The editor-tab wire conversation

`@orbitrace/fixtures/wire` holds one conversation between the app's editor-tab transport and the
editor extension's message host: every request the app posts and every message the host posts
back, written with core's message types. It has no Node dependency.

```ts
import { EDITOR_WIRE_CONVERSATION, withWireErrorText } from "@orbitrace/fixtures/wire";

for (const { name, request, replies } of EDITOR_WIRE_CONVERSATION) {
  // the app's test: make the call, expect `request` to be posted, then deliver `replies`
  // the host's test: handle `request`, expect `replies` to be posted
}
```

The two packages must agree on this layout, and each checks its real code against the same
conversation (`packages/app/test/webview-wire.test.ts`,
`packages/vscode/test/message-host.test.ts`), so neither test imports the other package's source.
When the layout changes, change the conversation with it: both tests then show what still has to
follow. An error's text is each host's own wording, so every error here carries `WIRE_ERROR_TEXT`
and a host's test passes its messages through `withWireErrorText` before it compares.
`test/wire.test.ts` checks the conversation itself against core's request and message checks.

## Scenarios

`SCENARIO_NAMES` lists them and `SCENARIOS[name].description` says what each one is for. The
table in `fixtures/README.md` has the same list. `DEMO_SCENARIO` and `demoFixturePaths()`
give the session bundled for a first run.

Constants that tests can check a reader against:

- `SPLIT_REPLY_LINE_USAGE` and `SPLIT_REPLY_MERGED_USAGE`: the usage on each of the five
  lines of the first reply in `split-reply`, and what they merge to. Only a field-by-field
  maximum gives the right answer: not the first line, not the last, not the sum.
- `IDLE_GAP_SECONDS`, `IDLE_GAP_SHORT_PAUSE_SECONDS`, `IDLE_GAP_LONG_COMMAND_SECONDS`: the
  exact lengths, in the raw timestamps, of the gaps in `idle-gap`.
- `INVENTED_LINE_TYPES`, `INVENTED_BLOCK_TYPE`, `INVENTED_TOOL_NAME`, `MODELS.unknownFamily`:
  the things in `unknown-lines` that a reader cannot know.

### On-demand scenarios

`EXTRA_SCENARIO_NAMES` lists scenarios that are generated only when asked for, with
`generateExtraSession(name)`. They are not in `SCENARIO_NAMES`, so `generateAll`, the manifest,
the committed files under `fixtures/config` and the golden replays never include them, and adding
one changes none of those files. `writeGeneratedSession(configDir, session)` writes one into a
temporary config folder for a test.

- `cache-write-split` (#190, #191): cache writes split by lifetime in `usage.cache_creation`
  (the main agent all to the 1-hour cache, one subagent all to the 5-minute cache, one half of
  each, one with no split, as an older Claude Code version writes), and a main agent and a
  subagent that change model part way. Its facts carry `cacheCreation` and `replyModels`.

A script can ask for the same things: `cacheWrites` (`"5m"`, `"1h"` or `"half"`) on a
`SubagentSpec`, on the session or on one reply, and `model` on one reply (`reply`, `use`, `say`).
Without them nothing changes: no `cache_creation` key is written and the facts keep their shape.

## Determinism

The same seed always writes the same bytes. Nothing reads the clock or `Math.random`: every
value comes from a small seeded generator (`createRng`), and every timestamp is counted
from the fixed start time of the scenario. Each agent draws from its own stream, so adding
a step to one agent does not change the text another agent writes.

## Commands

Run `npm run build` at the repository root first: these commands run the built
`@orbitrace/core`.

```sh
npm run generate -w @orbitrace/fixtures       # rewrite manifest.json and config/ from the generator
npm run check -w @orbitrace/fixtures          # exit 1 when they differ from the generator
npm run goldens -w @orbitrace/fixtures        # rewrite the golden replay files from the pipeline
npm run goldens:check -w @orbitrace/fixtures  # exit 1 when a golden differs, and say where
npm test -w @orbitrace/fixtures
```

After changing the generator, run `generate`, then `goldens`, and commit the changed files
with the change. After changing the parser, the replay builder or the export in
`@orbitrace/core`, run `goldens`.

## Writing a scenario

A scenario is a function that scripts a `SessionBuilder`:

```ts
session.open();
const main = session.main;
main.prompt();
main.use([main.tools.read(), main.tools.grep()], { thinking: true });
main.spawn([
  {
    agentType: "Explore",
    model: MODELS.haiku,
    effort: "low",
    script: (agent) => {
      agent.use(agent.tools.bash({ outcome: "error" }));
      agent.say();
    },
  },
]);
main.idle(120);
main.prompt();
main.say();
session.close();
```

Add it to `SCENARIO_NAMES` and `SCENARIOS` in `src/scenarios.ts`, then add a test for what it
promises in `test/scenarios.test.ts`. The checks in `test/fixture-shape.test.ts` and
`test/privacy.test.ts` cover every scenario without being told about it.

## What is in a fixture line

The raw line shape Claude Code writes, as far as a reader needs it: the common keys on
conversation lines, `message.id`, `message.model`, `message.usage` and one content block on
each `assistant` line, the `effort` keys, `tool_result` blocks on `user` lines, and the
bookkeeping line types. Real lines carry many more keys. Fixtures leave them out, and a
reader must not depend on them.

## Golden replay files

`fixtures/replays/<scenario>.replay.json` is what the replay pipeline of `@orbitrace/core`
makes of one fixture session. This package contains no parser and no replay builder of its
own: `src/goldens.ts` calls the real ones, in this order.

1. The Claude Code source adapter from `@orbitrace/core/node` lists the sessions under
   `fixtures/config` and opens the one the manifest names (`listSessions`, `openSession`).
2. `parseSession` reads the lines.
3. `buildReplay` builds the replay, with its default options.
4. `validateReplay` checks it against the replay v1 schema, and the keys in
   `FORBIDDEN_REPLAY_KEYS` are refused by name.
5. `exportReplay` writes it, indented, so that a change is a few lines in review.

The adapter is only pointed at `fixtures/config`. Root resolution is not used, because it
would also find the config folder of the person running the command.

```ts
import { readFileSync } from "node:fs";
import { validateReplay } from "@orbitrace/core";
import { DEMO_GOLDEN_REPLAY_PATH, goldenReplayPath } from "@orbitrace/fixtures";

const demo: unknown = JSON.parse(readFileSync(DEMO_GOLDEN_REPLAY_PATH, "utf8"));
if (!validateReplay(demo)) throw new Error("not a replay");
demo.agents.length; // 15: the main agent and fourteen subagents

goldenReplayPath("idle-gap"); // absolute path of fixtures/replays/idle-gap.replay.json
```

`DEMO_GOLDEN_REPLAY_PATH` is an absolute path on the machine that runs the code, so it is
for Node: a test, a build script or a bundler config. The file itself is plain JSON and is
safe to ship: structure and timing only, no text, path, project name or session id.

The manifest lists the files: `goldenReplays` at the top, `goldenReplay` on each session.
The generator writes those names (`goldenReplayFile`) but never the files.

### The golden test

`test/goldens.test.ts` runs the pipeline again for every session and compares the result
with the committed file, byte for byte. When they differ, the failure lists each place that
changed. `npm run goldens:check` prints the same lines:

```text
changed: replays/demo.replay.json
  agents[2].end: committed 81.2, regenerated 83.905
  agents[4].tools: committed has 7 item(s), regenerated has 8
golden replays differ from the pipeline. If the change is intended, run: npm run goldens -w @orbitrace/fixtures
```

The same test file checks that every golden is a valid replay v1, holds no forbidden key and
no id, path or project name of its session, and agrees with the `expected` block of the
manifest: the totals, each agent's model, effort, parent and counts, the waves and the idle
gaps. The `expected` block comes from the generator and the golden from the parser and the
builder, so the two are independent. `test/privacy.test.ts` runs the repository's privacy
check over the goldens.

A golden is never edited by hand. `npm run goldens` rewrites all of them; `goldens:check`
compares without writing, and also reports a `*.replay.json` file in `fixtures/replays/` that
is neither a golden nor the hand-written `minimal.replay.json` (delete it by hand, for
example after renaming a scenario).

`writeGoldenReplays`, `checkGoldenReplays`, `renderGoldenReplays` and
`describeGoldenReplayDiff` are exported for tests that need a set written somewhere else.
