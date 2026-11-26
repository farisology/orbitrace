# @orbitrace/fixtures

A seeded generator of synthetic Claude Code transcripts, and the paths of the generated
files in `fixtures/` at the repository root. Private to this repository: it is used by the
tests of the other packages and supplies the demo session.

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
[The contract](#the-contract)). So `@orbitrace/core` itself cannot list this package: the two
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
test fails if that changes. The package entry adds the paths and the functions that write
and check the folder.

Each subagent of a generated session carries its meta file as an object
(`session.subagents[n].meta`, a `RawSubagentMeta`), next to the paths of its files.

## The contract

The raw line vocabulary is defined once, in `@orbitrace/core` (`src/model/raw.ts`). This
package imports it and re-exports it, and defines none of it a second time:

- `KNOWN_RAW_LINE_TYPES`, `KNOWN_EFFORT_LEVELS` and the types `KnownRawLineType`,
  `KnownEffortLevel`, `RawLine`, `RawSubagentMeta` and `RawUsage` are the contract's own.
- `FullUsage` is `RawUsage` with every token count present, which is what the generator
  writes. It is derived from `RawUsage`, not written out again.
- `COMMON_LINE_KEYS`, `USAGE_KEYS` and `SUBAGENT_META_KEYS` are run-time lists of the keys that
  `RawLineBase`, `RawUsage` and `RawSubagentMeta` declare. The contract has types but no such
  lists, and the tests need them. `npm run typecheck` fails when a list and its type differ.
- `CONVERSATION_LINE_TYPES` names the known line types that carry the common keys.
  `HOUSEKEEPING_LINE_TYPES` is every other known type, computed from the contract's list.

Only these are this package's own: the `INVENTED_*` values, `MODELS` and
`BUILT_IN_AGENT_TYPES`.

`test/contract.test.ts` holds the checks: a generated line is a `RawLine`, a generated meta
object is a `RawSubagentMeta`, a generated session fits `SessionInput`, every line type in the
fixtures that is not invented is in `KNOWN_RAW_LINE_TYPES`, and every invented one is not.

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

## Determinism

The same seed always writes the same bytes. Nothing reads the clock or `Math.random`: every
value comes from a small seeded generator (`createRng`), and every timestamp is counted
from the fixed start time of the scenario. Each agent draws from its own stream, so adding
a step to one agent does not change the text another agent writes.

## Commands

```sh
npm run generate -w @orbitrace/fixtures   # rewrite fixtures/ from the generator
npm run check -w @orbitrace/fixtures      # exit 1 when fixtures/ differs from the generator
npm test -w @orbitrace/fixtures
```

After changing the generator, run `generate` and commit the changed files with the change.

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

Not written yet. They are the output of the replay model builder in `@orbitrace/core`
(issue #8) for each fixture, and that builder is not built yet. The manifest says
`"goldenReplays": "pending"` until then. This package contains no parser and no replay
builder of its own.
