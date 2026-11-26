// File compatibility and locking checks between node:sqlite and node-sqlite3-wasm.
// Run ./run-all.sh first (it writes data/node-sqlite.db and data/node-sqlite3-wasm.db).
// Usage: node crosscheck.mjs   (needs a runtime with node:sqlite)
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const { Database } = createRequire(import.meta.url)('node-sqlite3-wasm');
const q = "SELECT count(*) AS n FROM fts WHERE fts MATCH 'ledgerlark AND quillfern'";
const tryit = (label, fn) => { try { console.log(label + ':', fn()); } catch (e) { console.log(label + ': FAILED -', e.message.split('\n')[0]); } };

// 1. Can each engine open the other's file?
tryit('wasm opens node:sqlite file as written (WAL mode)', () => new Database('data/node-sqlite.db', { readOnly: true }).get(q).n);
copyFileSync('data/node-sqlite.db', 'data/x-delete.db');
const c = new DatabaseSync('data/x-delete.db'); c.exec('PRAGMA journal_mode=DELETE'); c.close();
tryit('wasm opens node:sqlite file after journal_mode=DELETE', () => new Database('data/x-delete.db', { readOnly: true }).get(q).n);
tryit('node:sqlite opens wasm file', () => new DatabaseSync('data/node-sqlite3-wasm.db', { readOnly: true }).prepare(q).get().n);

// 2. node-sqlite3-wasm locks by creating a "<file>.lock" directory. Simulate a process that died holding it.
copyFileSync('data/node-sqlite3-wasm.db', 'data/x-stale.db');
rmSync('data/x-stale.db.lock', { recursive: true, force: true });
mkdirSync('data/x-stale.db.lock');
tryit('wasm read with a leftover .lock directory', () => { const d = new Database('data/x-stale.db'); try { return d.get(q).n; } finally { d.close(); } });
tryit('node:sqlite read with the same leftover .lock directory', () => new DatabaseSync('data/x-stale.db', { readOnly: true }).prepare(q).get().n);
rmSync('data/x-stale.db.lock', { recursive: true, force: true });

// 3. Do the two engines exclude each other? This process holds a write lock with node:sqlite,
//    then a child process tries to write with each engine.
copyFileSync('data/x-delete.db', 'data/x-lock.db');
const holder = new DatabaseSync('data/x-lock.db');
holder.exec('BEGIN EXCLUSIVE; INSERT INTO messages(id,session,ts,role,text) VALUES (900001,\'s\',\'t\',\'user\',\'held\')');
const child = (engine) => {
  const code = engine === 'wasm'
    ? `const {Database}=require('node-sqlite3-wasm');const d=new Database('data/x-lock.db');d.exec("INSERT INTO messages(id,session,ts,role,text) VALUES (900002,'s','t','user','child')");d.close();console.log('wrote')`
    : `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/x-lock.db');d.exec("INSERT INTO messages(id,session,ts,role,text) VALUES (900002,'s','t','user','child')");d.close();console.log('wrote')`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: process.env });
  return (r.stdout.trim() || r.stderr.split('\n').find((l) => /Error|error/.test(l)) || 'exit ' + r.status).slice(0, 120);
};
console.log('node:sqlite child write while node:sqlite holds EXCLUSIVE:', child('node'));
console.log('wasm child write while node:sqlite holds EXCLUSIVE:', child('wasm'));
holder.exec('ROLLBACK'); holder.close();
tryit('integrity_check after the test', () => new DatabaseSync('data/x-lock.db', { readOnly: true }).prepare('PRAGMA integrity_check').get().integrity_check);
