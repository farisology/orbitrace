// Generates synthetic session records. All text is invented from a fixed word list.
// Usage: node generate.mjs [messages=50000] [out=data/messages.jsonl]
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const total = Number(process.argv[2] ?? 50000);
const out = process.argv[3] ?? "data/messages.jsonl";
mkdirSync(dirname(out), { recursive: true });

// mulberry32: small seeded PRNG so every run produces the same file.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(24);

const syllables = [
  "ba",
  "ko",
  "ri",
  "tu",
  "me",
  "lan",
  "sor",
  "vi",
  "dex",
  "pol",
  "nur",
  "qua",
  "zen",
  "tal",
  "fir",
  "gro",
  "hy",
  "jun",
  "wex",
  "yo",
];
const vocabSize = 3000;
const vocab = [];
for (let i = 0; i < vocabSize; i++) {
  const n = 2 + Math.floor(rand() * 2);
  let w = "";
  for (let j = 0; j < n; j++) w += syllables[Math.floor(rand() * syllables.length)];
  vocab.push(w + (i % 7 === 0 ? String(i % 50) : ""));
}
// Fixed probe words with known frequency so queries are comparable between runs.
const rare = "zorblat"; // planted in about 0.1% of messages
const medium = "quillfern"; // about 2%
const common = "ledgerlark"; // about 30%

// Zipf-like pick: low indexes are much more likely.
function word() {
  return vocab[Math.floor(Math.pow(rand(), 2.2) * vocabSize)];
}

const stream = createWriteStream(out);
const sessions = 500;
const start = Date.UTC(2026, 0, 1);
let id = 0;
for (let s = 0; s < sessions; s++) {
  const sid = "synthetic-session-" + String(s).padStart(4, "0");
  const perSession = Math.floor(total / sessions);
  let ts = start + s * 3600_000 * 5;
  for (let m = 0; m < perSession; m++) {
    ts += 1000 + Math.floor(rand() * 30000);
    const len = 8 + Math.floor(rand() * 70);
    const words = [];
    for (let k = 0; k < len; k++) words.push(word());
    const r = rand();
    if (r < 0.001) words.splice(3, 0, rare);
    if (rand() < 0.02) words.splice(5, 0, medium);
    if (rand() < 0.3) words.splice(2, 0, common);
    if (rand() < 0.01) words.splice(4, 0, common, medium); // adjacent pair for phrase queries
    stream.write(
      JSON.stringify({
        id: ++id,
        session: sid,
        ts: new Date(ts).toISOString(),
        role: m % 2 ? "assistant" : "user",
        text: words.join(" "),
      }) + "\n",
    );
  }
}
stream.end(() => console.log(`wrote ${id} records to ${out}`));
