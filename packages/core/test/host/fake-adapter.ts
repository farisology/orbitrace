// An in-memory SourceAdapter for the session replayer tests. Every session, line and path in it
// is invented; transcript lines come from the parser's synthetic builders.
import type {
  LineSource,
  RawSubagentMeta,
  SessionChangeListener,
  SessionRef,
  SourceAdapter,
  SourceRoot,
} from "../../src/index.js";

export const ROOT: SourceRoot = {
  runtime: "claude-code",
  root: "/srv/example-config",
  resolvedBy: "user-setting",
  available: true,
};

/** Text an invented file error carries, standing for a real path. Must never reach a message. */
export const FAKE_PATH = "/srv/example-config/projects/example/hidden.jsonl";

export interface FakeSubagent {
  readonly agentId: string;
  readonly meta: RawSubagentMeta | null;
  readonly lines: string[];
}

export interface FakeSession {
  ref: SessionRef;
  main: string[];
  subagents: FakeSubagent[];
  /** `openSession` rejects. */
  failOpen?: boolean;
  /** Reading the main transcript rejects after the first line. */
  failRead?: boolean;
}

export function fakeRef(key: string, lastActivity: number, live: SessionRef["live"]): SessionRef {
  return {
    key,
    runtime: "claude-code",
    source: ROOT,
    projectLabel: "example-project",
    sessionId: `sess-${key}`,
    lastActivity,
    live,
    subagentCount: 0,
    locator: `${ROOT.root}/projects/example/${key}.jsonl`,
  };
}

async function* failingLines(lines: readonly string[]): AsyncGenerator<string> {
  if (lines[0] !== undefined) yield lines[0];
  throw new Error(`EIO: read failed at ${FAKE_PATH}`);
}

export interface FakeWorld {
  readonly adapter: SourceAdapter;
  readonly sessions: FakeSession[];
  /** Number of `listSessions` and `openSession` calls so far. */
  readonly counts: { list: number; open: number; watch: number; unwatch: number };
  /** Report a change of the session with this key to every watcher, with a changed ref. */
  change(key: string, patch?: Partial<SessionRef>): void;
  /** Number of watchers currently registered for a key. */
  watchers(key: string): number;
  /** Make every `openSession` wait until the returned function is called. */
  hold(): () => void;
}

export interface FakeWorldOptions {
  /** Give the adapter a `watchSession`. Default true. */
  readonly watch?: boolean;
  /** `watchSession` throws. */
  readonly watchThrows?: boolean;
}

export function fakeWorld(sessions: FakeSession[], options: FakeWorldOptions = {}): FakeWorld {
  const counts = { list: 0, open: 0, watch: 0, unwatch: 0 };
  const listeners = new Map<string, Set<SessionChangeListener>>();
  const byKey = (key: string): FakeSession | undefined => sessions.find((s) => s.ref.key === key);
  let gate: Promise<void> | null = null;

  const adapter: SourceAdapter = {
    runtime: "claude-code",
    displayName: "Example runtime",
    resolveRoots: async () => [ROOT],
    listSessions: async (root) => {
      counts.list += 1;
      return sessions.filter((s) => s.ref.source.root === root.root).map((s) => s.ref);
    },
    openSession: async (ref) => {
      counts.open += 1;
      await (gate ?? Promise.resolve());
      const session = byKey(ref.key);
      if (session === undefined || session.failOpen === true) {
        throw new Error(`ENOENT: no such file, open '${FAKE_PATH}'`);
      }
      const main: LineSource =
        session.failRead === true ? failingLines([...session.main]) : [...session.main];
      return {
        main,
        subagents: session.subagents.map((sub) => ({
          agentId: sub.agentId,
          meta: sub.meta,
          lines: [...sub.lines],
        })),
      };
    },
  };
  if (options.watch !== false) {
    adapter.watchSession = (ref, listener) => {
      if (options.watchThrows === true) throw new Error(`EMFILE: watch ${FAKE_PATH}`);
      counts.watch += 1;
      const set = listeners.get(ref.key) ?? new Set<SessionChangeListener>();
      set.add(listener);
      listeners.set(ref.key, set);
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        counts.unwatch += 1;
        set.delete(listener);
      };
    };
  }

  return {
    adapter,
    sessions,
    counts,
    change(key, patch = {}) {
      const session = byKey(key);
      if (session === undefined) return;
      session.ref = { ...session.ref, ...patch };
      for (const listener of [...(listeners.get(key) ?? [])]) listener(session.ref);
    },
    watchers(key) {
      return listeners.get(key)?.size ?? 0;
    },
    hold() {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
}
