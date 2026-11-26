// Usage: node bench.mjs <option> [input=data/messages.jsonl]
// option: node-sqlite | node-sqlite3-wasm | sqlite-wasm | jsonl
// Run each option in its own process so memory numbers do not mix.
import { createRequire } from 'node:module';
import { readFileSync, statSync, writeFileSync, rmSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
const require = createRequire(import.meta.url);

const option = process.argv[2];
const input = process.argv[3] ?? 'data/messages.jsonl';
mkdirSync('data', { recursive: true });
const records = readFileSync(input, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));

// Each query: FTS5 MATCH string, and the same query for the in-memory index.
const queries = [
  { name: 'rare term', fts: 'zorblat', terms: ['zorblat'], phrase: null },
  { name: 'medium term', fts: 'quillfern', terms: ['quillfern'], phrase: null },
  { name: 'common term', fts: 'ledgerlark', terms: ['ledgerlark'], phrase: null },
  { name: 'two terms AND', fts: 'ledgerlark AND quillfern', terms: ['ledgerlark', 'quillfern'], phrase: null },
  { name: 'phrase', fts: '"ledgerlark quillfern"', terms: ['ledgerlark', 'quillfern'], phrase: 'ledgerlark quillfern' },
];
const baseline_rss_mb = +(process.memoryUsage().rss / 1048576).toFixed(1); // after loading the input
const RUNS = 20;
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const result = { option, node: process.versions.node, electron: process.versions.electron ?? null, messages: records.length };

// Time one query function RUNS times after one warm-up; return median ms and match count.
function timeQuery(fn) {
  const count = fn();
  const t = [];
  for (let i = 0; i < RUNS; i++) { const t0 = process.hrtime.bigint(); fn(); t.push(ms(t0)); }
  return { median_ms: +median(t).toFixed(3), matches: count };
}

const ddl = `CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT, ts TEXT, role TEXT, text TEXT);
CREATE VIRTUAL TABLE fts USING fts5(text, content='messages', content_rowid='id');`;
const ins = 'INSERT INTO messages(id,session,ts,role,text) VALUES(?,?,?,?,?)';
const insFts = 'INSERT INTO fts(rowid,text) VALUES(?,?)';
const count = (q) => `SELECT count(*) AS n FROM fts WHERE fts MATCH '${q.replaceAll("'", "''")}'`;
// Count plus the first 20 hits in id order, as a viewer would show them.
const top = (q) => `SELECT m.id, m.session, m.ts FROM fts JOIN messages m ON m.id = fts.rowid WHERE fts MATCH '${q.replaceAll("'", "''")}' ORDER BY m.id LIMIT 20`;

try {
if (option === 'node-sqlite') {
  const { DatabaseSync } = await import('node:sqlite');
  const file = 'data/node-sqlite.db';
  for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
  const t0 = process.hrtime.bigint();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  db.exec(ddl);
  const a = db.prepare(ins), b = db.prepare(insFts);
  db.exec('BEGIN');
  for (const r of records) { a.run(r.id, r.session, r.ts, r.role, r.text); b.run(r.id, r.text); }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  result.write_ms = +ms(t0).toFixed(1);
  db.close();
  result.file_bytes = statSync(file).size;
  const dbq = new DatabaseSync(file, { readOnly: true });
  result.queries = Object.fromEntries(queries.map((q) => [q.name, {
    count: timeQuery(() => dbq.prepare(count(q.fts)).get().n),
    top20: timeQuery(() => dbq.prepare(top(q.fts)).all().length),
  }]));
} else if (option === 'node-sqlite3-wasm') {
  const { Database } = require('node-sqlite3-wasm');
  const file = 'data/node-sqlite3-wasm.db';
  for (const f of [file, file + '.lock']) rmSync(f, { force: true, recursive: true });
  const t0 = process.hrtime.bigint();
  const db = new Database(file);
  db.exec(ddl);
  const a = db.prepare(ins), b = db.prepare(insFts);
  db.exec('BEGIN');
  for (const r of records) { a.run([r.id, r.session, r.ts, r.role, r.text]); b.run([r.id, r.text]); }
  db.exec('COMMIT');
  a.finalize(); b.finalize();
  result.write_ms = +ms(t0).toFixed(1);
  db.close();
  result.file_bytes = statSync(file).size;
  const dbq = new Database(file, { readOnly: true });
  result.queries = Object.fromEntries(queries.map((q) => [q.name, {
    count: timeQuery(() => dbq.get(count(q.fts)).n),
    top20: timeQuery(() => dbq.all(top(q.fts)).length),
  }]));
} else if (option === 'sqlite-wasm') {
  // In Node this build has no file backend. It runs in memory and the bytes are exported to a file.
  const mod = await import('@sqlite.org/sqlite-wasm');
  const file = 'data/sqlite-wasm.db';
  rmSync(file, { force: true });
  const t0 = process.hrtime.bigint();
  const s = await mod.default();
  const db = new s.oo1.DB(':memory:');
  db.exec(ddl);
  const a = db.prepare(ins), b = db.prepare(insFts);
  db.exec('BEGIN');
  for (const r of records) { a.bind([r.id, r.session, r.ts, r.role, r.text]).stepReset(); b.bind([r.id, r.text]).stepReset(); }
  db.exec('COMMIT');
  a.finalize(); b.finalize();
  result.write_ms_build = +ms(t0).toFixed(1);
  const t1 = process.hrtime.bigint();
  writeFileSync(file, s.capi.sqlite3_js_db_export(db));
  result.export_ms = +ms(t1).toFixed(1);
  result.write_ms = +(result.write_ms_build + result.export_ms).toFixed(1);
  result.file_bytes = statSync(file).size;
  result.queries = Object.fromEntries(queries.map((q) => [q.name, {
    count: timeQuery(() => db.selectValue(count(q.fts))),
    top20: timeQuery(() => db.selectObjects(top(q.fts)).length),
  }]));
  db.close();
} else if (option === 'jsonl') {
  // Plain files: records as JSON lines plus an in-memory inverted index rebuilt on start.
  const file = 'data/jsonl-store.jsonl';
  const t0 = process.hrtime.bigint();
  const lines = records.map((r) => JSON.stringify(r));
  writeFileSync(file, lines.join('\n') + '\n');
  result.write_ms = +ms(t0).toFixed(1);
  result.file_bytes = statSync(file).size;
  // Index build: read file, record byte offsets, tokenise, build term -> sorted id list.
  const rss0 = process.memoryUsage().rss;
  const t1 = process.hrtime.bigint();
  const buf = readFileSync(file);
  const texts = new Array(records.length + 1);
  const offsets = new Float64Array(records.length + 1);
  const lengths = new Uint32Array(records.length + 1);
  const index = new Map();
  let pos = 0, n = 0;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos); if (end < 0) end = buf.length;
    const rec = JSON.parse(buf.toString('utf8', pos, end));
    offsets[rec.id] = pos; lengths[rec.id] = end - pos; texts[rec.id] = rec.text; n++;
    for (const term of new Set(rec.text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))) {
      let p = index.get(term); if (!p) index.set(term, (p = [])); p.push(rec.id);
    }
    pos = end + 1;
  }
  result.index_build_ms = +ms(t1).toFixed(1);
  result.index_terms = index.size;
  result.index_rss_delta_mb = +((process.memoryUsage().rss - rss0) / 1048576).toFixed(1);
  const fd = openSync(file, 'r');
  const intersect = (x, y) => { const o = []; let i = 0, j = 0; while (i < x.length && j < y.length) { if (x[i] === y[j]) { o.push(x[i]); i++; j++; } else if (x[i] < y[j]) i++; else j++; } return o; };
  const run = (q) => {
    let ids = null;
    for (const t of q.terms) { const p = index.get(t) ?? []; ids = ids ? intersect(ids, p) : p; }
    if (q.phrase) ids = ids.filter((id) => texts[id].includes(q.phrase));
    return ids;
  };
  result.queries = Object.fromEntries(queries.map((q) => [q.name, {
    count: timeQuery(() => run(q).length),
    // Read each hit's line back from the file by offset and parse it, as the SQLite top20 join returns rows.
    top20: timeQuery(() => run(q).slice(0, 20).map((id) => {
      const b = Buffer.allocUnsafe(lengths[id]);
      readSync(fd, b, 0, lengths[id], offsets[id]);
      const r = JSON.parse(b.toString('utf8'));
      return { id: r.id, session: r.session, ts: r.ts };
    }).length),
  }]));
  closeSync(fd);
} else {
  console.error('unknown option'); process.exit(1);
}
} catch (e) {
  // Report a failed option (for example node:sqlite on an old runtime) instead of aborting the run.
  result.error = e.message.split('\n')[0];
}
result.baseline_rss_mb = baseline_rss_mb;
result.rss_mb = +(process.memoryUsage().rss / 1048576).toFixed(1);
console.log(JSON.stringify(result, null, 1));
