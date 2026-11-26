#!/bin/sh
# Runs every option in its own process on one runtime, then prints a summary table.
# An option that cannot load on the runtime is reported as FAILED, not skipped silently.
# Usage: ./run-all.sh [node-binary]   (default: node)
# For VS Code's runtime: ELECTRON_RUN_AS_NODE=1 ./run-all.sh "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
set -e
cd "$(dirname "$0")"
RT="${1:-node}"
[ -f data/messages.jsonl ] || "$RT" generate.mjs
rm -f data/r-*.json
for o in node-sqlite node-sqlite3-wasm sqlite-wasm jsonl; do
  "$RT" bench.mjs "$o" > "data/r-$o.json"
done
"$RT" summarize.mjs
