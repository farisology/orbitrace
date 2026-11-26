/**
 * Test helpers. Every value is invented: project names such as `kite-workshop`, keys such as
 * `claude-code:test-1`, paths under `/workspace` or a temporary folder. Nothing reads the real
 * home folder or config folder.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayModel, SessionRef, SessionSummary, SourceRoot } from "@orbitrace/core";
import {
  claudeCodeAdapter,
  createSessionReplayer,
  SessionReplayError,
  type SessionReplayListener,
  type SessionReplayer,
} from "@orbitrace/core/node";
import { DEMO_GOLDEN_REPLAY_PATH, FIXTURE_CONFIG_DIR } from "@orbitrace/fixtures";

/** A synthetic config root. */
export const TEST_ROOT: SourceRoot = {
  runtime: "claude-code",
  root: "/workspace/.config-root",
  resolvedBy: "user-setting",
  available: true,
};

/** A synthetic session summary. */
export function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    key: "claude-code:test-1",
    runtime: "claude-code",
    projectLabel: "kite-workshop",
    sessionId: "00000000-0000-4000-8000-000000000001",
    lastActivity: Date.UTC(2026, 0, 15, 9, 0, 0),
    live: "unknown",
    subagentCount: 0,
    ...overrides,
  };
}

/** A synthetic session ref whose transcript sits in `projects/<projectFolder>/`. */
export function makeRef(summary: SessionSummary, projectFolder: string): SessionRef {
  return {
    ...summary,
    source: TEST_ROOT,
    locator: `${TEST_ROOT.root}/projects/${projectFolder}/${summary.sessionId}.jsonl`,
  };
}

/** The demo golden replay from the synthetic fixtures. */
export function demoReplay(): ReplayModel {
  return JSON.parse(readFileSync(DEMO_GOLDEN_REPLAY_PATH, "utf8")) as ReplayModel;
}

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export interface FakeFollow {
  readonly key: string;
  readonly listener: SessionReplayListener;
  stopped: boolean;
}

export interface FakeReplayer extends SessionReplayer {
  readonly follows: FakeFollow[];
  listCalls: number;
}

/**
 * A replayer over fixed refs. `load` returns `replay` for a known key; `follow` records the
 * listener so a test pushes updates itself.
 */
export function fakeReplayer(
  refs: readonly SessionRef[],
  options: { replay?: ReplayModel; listError?: unknown } = {},
): FakeReplayer {
  const follows: FakeFollow[] = [];
  const replayer: FakeReplayer = {
    follows,
    listCalls: 0,
    async list() {
      replayer.listCalls += 1;
      if (options.listError !== undefined) throw options.listError;
      return refs.map(
        ({ key, runtime, projectLabel, sessionId, lastActivity, live, subagentCount }) => ({
          key,
          runtime,
          projectLabel,
          sessionId,
          lastActivity,
          live,
          subagentCount,
        }),
      );
    },
    async find(key) {
      const ref = refs.find((candidate) => candidate.key === key);
      if (ref === undefined) throw new SessionReplayError("not-found", "No session with that key.");
      return ref;
    },
    async load(key) {
      await replayer.find(key);
      return options.replay ?? demoReplay();
    },
    follow(key, listener) {
      const entry: FakeFollow = { key, listener, stopped: false };
      follows.push(entry);
      return () => {
        entry.stopped = true;
      };
    },
  };
  return replayer;
}

/**
 * A real session replayer from core over the committed synthetic fixtures, with a watch that
 * the test triggers through `notify` (the Claude Code adapter has no watch yet).
 */
export function fixtureReplayer(): {
  replayer: SessionReplayer;
  notify(): void;
  watching(): number;
} {
  const watchers = new Set<() => void>();
  const adapter = {
    ...claudeCodeAdapter,
    resolveRoots: claudeCodeAdapter.resolveRoots.bind(claudeCodeAdapter),
    listSessions: claudeCodeAdapter.listSessions.bind(claudeCodeAdapter),
    openSession: claudeCodeAdapter.openSession.bind(claudeCodeAdapter),
    watchSession(ref: SessionRef, listener: (ref: SessionRef) => void) {
      const notify = (): void => listener(ref);
      watchers.add(notify);
      return () => {
        watchers.delete(notify);
      };
    },
  };
  const replayer = createSessionReplayer({
    adapters: [adapter],
    roots: [
      {
        runtime: "claude-code",
        root: FIXTURE_CONFIG_DIR,
        resolvedBy: "user-setting",
        available: true,
      },
    ],
  });
  return {
    replayer,
    notify: () => [...watchers].forEach((notify) => notify()),
    watching: () => watchers.size,
  };
}

const created: string[] = [];

/** A new empty folder under the system's temporary folder. */
export function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "orbitrace-vscode-")));
  created.push(dir);
  return dir;
}

/** Remove every folder makeTempDir created. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
