// Prints a table from data/r-*.json (written by run-all.sh).
import { readFileSync, readdirSync } from 'node:fs';
const files = readdirSync('data').filter((f) => /^r-.*\.json$/.test(f)).sort();
const rs = files.map((f) => JSON.parse(readFileSync('data/' + f, 'utf8')));
const ok = rs.filter((r) => !r.error);
console.log('runtime: node ' + rs[0].node + (rs[0].electron ? ' (electron ' + rs[0].electron + ')' : ''));
for (const r of rs.filter((r) => r.error)) console.log(`${r.option}: FAILED - ${r.error}`);
console.log('\noption | write_ms | file_MB | rss_MB (baseline) | extra');
for (const r of ok) console.log([r.option, r.write_ms, (r.file_bytes / 1048576).toFixed(1), r.rss_mb + ' (' + r.baseline_rss_mb + ')',
  r.option === 'jsonl' ? `index_build_ms=${r.index_build_ms} terms=${r.index_terms} index_rss_delta_MB=${r.index_rss_delta_mb}`
    : r.option === 'sqlite-wasm' ? `build_ms=${r.write_ms_build} export_ms=${r.export_ms}` : ''].join(' | '));
if (!ok.length) process.exit(0);
console.log('\nquery (median of 20, ms) | matches | ' + ok.map((r) => r.option + ' count/top20').join(' | '));
for (const name of Object.keys(ok[0].queries)) {
  const counts = new Set(ok.map((r) => r.queries[name].count.matches));
  console.log(name + ' | ' + [...counts].join(',') + (counts.size > 1 ? ' (MISMATCH)' : '') + ' | '
    + ok.map((r) => `${r.queries[name].count.median_ms}/${r.queries[name].top20.median_ms}`).join(' | '));
}
