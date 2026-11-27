#!/usr/bin/env node
// Runs the demo page's benchmark (demo/bench.ts) in headless Chrome and prints the result.
//
//   npm run bench:browser                  (in packages/renderer, after `npm run build` at the root)
//   CHROME_PATH=/path/to/chrome npm run bench:browser
//   BENCH_DPR=2 BENCH_CPU_THROTTLE=4 BENCH_AGENTS=15,100,500 npm run bench:browser
//
// BENCH_DPR sets the device pixel ratio (default 2, a high-density laptop screen; the backing
// store has four times the pixels of DPR 1). BENCH_CPU_THROTTLE slows the page's CPU by that
// factor through the DevTools protocol, to stand in for a slower machine (default 1, off).
// BENCH_AGENTS picks the session sizes (default 15, 100 and 500 agents).
//
// Starts the demo's Vite dev server on 127.0.0.1, launches Chrome headless with a throwaway
// profile, opens the page with ?bench=1 and waits for window.__orbitraceBench through the
// DevTools protocol. Needs Node 22 or later (global WebSocket). Headless Chrome is not a
// laptop with a display: treat its numbers as a lower bound on what a real window does, and
// check the result visually in the app as well.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChrome() {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

const DPR = Number(process.env.BENCH_DPR ?? 2) || 2;
const CPU_THROTTLE = Math.max(1, Number(process.env.BENCH_CPU_THROTTLE ?? 1) || 1);
const AGENTS = (process.env.BENCH_AGENTS ?? "").replace(/[^0-9,]/g, "");

function launchChrome(path, profileDir) {
  const chrome = spawn(
    path,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--enable-precise-memory-info",
      `--force-device-scale-factor=${DPR}`,
      "--window-size=1280,860",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = new Promise((resolveEndpoint, reject) => {
    let buffer = "";
    chrome.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolveEndpoint(match[1]);
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited early (${code})`)));
    setTimeout(() => reject(new Error("Chrome did not start in 20 s")), 20000);
  });
  return { chrome, endpoint };
}

function cdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const open = new Promise((ok, fail) => {
    socket.addEventListener("open", ok);
    socket.addEventListener("error", fail);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject: fail });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { open, send, close: () => socket.close() };
}

async function main() {
  const server = await createServer({
    configFile: join(packageDir, "demo", "vite.config.ts"),
    server: { port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error("Vite did not report a URL");
  const profileDir = mkdtempSync(join(tmpdir(), "orbitrace-bench-"));
  const { chrome, endpoint } = launchChrome(findChrome(), profileDir);
  try {
    const client = cdp(await endpoint);
    await client.open;
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    if (CPU_THROTTLE > 1) {
      await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE }, sessionId);
    }
    const query = `?bench=1${AGENTS ? `&agents=${AGENTS}` : ""}`;
    await client.send("Page.navigate", { url: `${base}${query}` }, sessionId);
    const evaluate = (expression, awaitPromise = false) =>
      client.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId);
    const deadline = Date.now() + 120000;
    for (;;) {
      const { result } = await evaluate("typeof window.__orbitraceBench");
      if (result.value === "object") break;
      if (Date.now() > deadline) throw new Error("the benchmark did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    const { result } = await evaluate("window.__orbitraceBench", true);
    const { result: renderer } = await evaluate(
      "(() => { const g = document.createElement('canvas').getContext('webgl'); const i = g && g.getExtension('WEBGL_debug_renderer_info'); return i ? /SwiftShader|llvmpipe|Software/i.test(g.getParameter(i.UNMASKED_RENDERER_WEBGL)) : null; })()",
    );
    const { result: version } = await evaluate("navigator.userAgent");
    console.log(
      JSON.stringify(
        {
          machine: {
            cpu: cpus()[0]?.model,
            cores: cpus().length,
            memoryGB: Math.round(totalmem() / 2 ** 30),
          },
          browser: (version.value.match(/Chrome\/[\d.]+/) ?? ["unknown"])[0],
          headless: true,
          softwareRendering: renderer.value,
          cpuThrottle: CPU_THROTTLE,
          ...result.value,
        },
        null,
        2,
      ),
    );
    client.close();
  } finally {
    const exited = new Promise((done) => {
      if (chrome.exitCode !== null) done();
      else chrome.once("exit", done);
      setTimeout(done, 5000);
    });
    chrome.kill();
    await exited;
    await server.close();
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(`bench-browser: ${error.message}`);
  process.exitCode = 1;
});
