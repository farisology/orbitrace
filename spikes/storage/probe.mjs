// Reports runtime versions and whether each SQLite build has FTS5.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null }));
async function check(name, fn) {
  try { console.log(name, 'FTS5 =', await fn()); } catch (e) { console.log(name, 'FTS5 = no/err:', e.message.split('\n')[0]); }
}
await check('node:sqlite', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES (\'hello world\')');
  return db.prepare("SELECT count(*) n FROM t WHERE t MATCH 'hello'").get().n === 1 ? 'yes' : 'no';
});
await check('sql.js', async () => {
  const init = require('sql.js'); const S = await init(); const db = new S.Database();
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES (\'hello world\')');
  return db.exec("SELECT count(*) FROM t WHERE t MATCH 'hello'")[0].values[0][0] === 1 ? 'yes' : 'no';
});
await check('node-sqlite3-wasm', async () => {
  const { Database } = require('node-sqlite3-wasm'); const db = new Database(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES (\'hello world\')');
  return db.get("SELECT count(*) n FROM t WHERE t MATCH 'hello'").n === 1 ? 'yes' : 'no';
});
await check('@sqlite.org/sqlite-wasm', async () => {
  const mod = await import('@sqlite.org/sqlite-wasm'); const s = await mod.default(); const db = new s.oo1.DB(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x); INSERT INTO t VALUES (\'hello world\')');
  return db.selectValue("SELECT count(*) FROM t WHERE t MATCH 'hello'") === 1 ? 'yes' : 'no';
});
