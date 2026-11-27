#!/usr/bin/env node
// Renders the extension icon for the VS Code Marketplace and Open VSX listing:
//
//   node packages/vscode/scripts/build-icon.mjs           render media/icon.png with headless Chrome
//   node packages/vscode/scripts/build-icon.mjs --check   render nothing; exit 1 if the committed
//                                                         icon is not a 256x256 RGBA PNG with
//                                                         transparent corners
//
// The listing needs a PNG of at least 128x128 pixels; an SVG icon is refused by vsce. The icon
// is design/icons/favicon.svg (the mark on its own dark tile, see design/identity.md) drawn at
// 256x256 without changes. The tile keeps the near-white trace visible on the light and the dark
// Marketplace pages.
//
// Chrome is the only tool used, so the script needs no dependency. It runs headless with a new,
// empty profile in a temporary folder, on a local page whose only image is the SVG as a data:
// URL and whose Content-Security-Policy blocks everything else, so the render makes no network
// request. Set CHROME_PATH, or pass --chrome <path>, when Chrome is not in the default place.
// Different Chrome versions can antialias edges slightly differently, so the bytes of a new
// render may differ from the committed file; --check tests the format, not the bytes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(packageDir, "..", "..");

/** Width and height of the rendered icon, in pixels. The Marketplace asks for 128 or more. */
export const ICON_SIZE = 256;

/** The design source of the icon. */
export const SOURCE_SVG = join(repoDir, "design", "icons", "favicon.svg");

/** The committed icon that `icon` in package.json names. */
export const ICON_PNG = join(packageDir, "media", "icon.png");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The page Chrome renders: the SVG as a data: URL, drawn at `size` pixels on a transparent page.
 * The Content-Security-Policy allows data: images only, so nothing is fetched.
 * @param {string} svg the SVG text
 * @param {number} [size]
 * @returns {string}
 */
export function iconPage(svg, size = ICON_SIZE) {
  const data = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}img{display:block}</style>",
    `</head><body><img alt="" width="${size}" height="${size}" src="${data}"></body></html>`,
    "",
  ].join("\n");
}

/**
 * The Chrome command-line arguments for one render.
 * @param {{ page: string, out: string, profile: string, size?: number }} options
 *   page: the HTML file; out: the PNG to write; profile: an empty folder for Chrome's profile
 * @returns {string[]}
 */
export function chromeArgs({ page, out, profile, size = ICON_SIZE }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--metrics-recording-only",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000",
    `--user-data-dir=${profile}`,
    `--window-size=${size},${size}`,
    `--screenshot=${out}`,
    pathToFileURL(page).href,
  ];
}

/**
 * Where to find Chrome: CHROME_PATH when set, otherwise the usual install path of the platform.
 * @param {NodeJS.Platform} [platform]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultChromePath(platform = process.platform, env = process.env) {
  if (env.CHROME_PATH) return env.CHROME_PATH;
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "google-chrome";
}

/**
 * Read a PNG file: its header and, for a non-interlaced 8-bit RGBA image, its pixels.
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, bitDepth: number, colorType: number, interlace: number, pixels: Buffer | null }}
 *   pixels: RGBA bytes, row by row, or null for any other format
 */
export function readPng(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG file");
  }
  /** @type {Buffer[]} */
  const idat = [];
  let header = null;
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error("truncated PNG chunk");
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
        interlace: data.readUInt8(12),
      };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header) throw new Error("PNG has no IHDR chunk");
  if (idat.length === 0) throw new Error("PNG has no image data");
  if (header.colorType !== 6 || header.bitDepth !== 8 || header.interlace !== 0) {
    return { ...header, pixels: null };
  }
  return {
    ...header,
    pixels: unfilter(inflateSync(Buffer.concat(idat)), header.width, header.height),
  };
}

/**
 * Undo the PNG row filters of 8-bit RGBA image data (PNG specification, section 9).
 * @param {Buffer} raw the inflated image data: per row, a filter-type byte and the row's bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} RGBA bytes, row by row
 */
export function unfilter(raw, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is too short");
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? out.readUInt8(y * stride + x - bpp) : 0;
      const b = y > 0 ? out.readUInt8((y - 1) * stride + x) : 0;
      const c = x >= bpp && y > 0 ? out.readUInt8((y - 1) * stride + x - bpp) : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter type ${filter}`);
      out[y * stride + x] = (row.readUInt8(x) + predictor) & 0xff;
    }
  }
  return out;
}

/**
 * The RGBA value of one pixel.
 * @param {{ width: number, pixels: Buffer }} png
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
export function pixelAt(png, x, y) {
  const at = (y * png.width + x) * 4;
  return [...png.pixels.subarray(at, at + 4)];
}

/**
 * A `#RRGGBB` colour as [r, g, b].
 * @param {string} hex
 * @returns {number[]}
 */
export function hexToRgb(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error("not a #RRGGBB colour");
  return match.slice(1).map((part) => Number.parseInt(part, 16));
}

/** The tile colour of favicon.svg: `void` in design/tokens.json. */
export const TILE_RGB = hexToRgb(
  JSON.parse(readFileSync(join(repoDir, "design", "tokens.json"), "utf8")).color.ground.void,
);

/**
 * What is wrong with an icon file for the listing: not a PNG, the wrong size, not 8-bit RGBA,
 * a top-left corner that is not transparent (the tile has rounded corners), or a tile that does
 * not fill the image (the pixel a twentieth in from the left edge, halfway down, must be the
 * opaque tile colour; a render at the wrong scale leaves it transparent).
 * @param {Buffer} buffer
 * @param {number} [size]
 * @returns {string[]} problems, empty when the icon is fine
 */
export function iconProblems(buffer, size = ICON_SIZE) {
  let png;
  try {
    png = readPng(buffer);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (png.width !== size || png.height !== size) {
    return [`icon is ${png.width}x${png.height}, expected ${size}x${size}`];
  }
  if (png.pixels === null) return ["icon is not a non-interlaced 8-bit RGBA PNG"];
  const pixels = { width: png.width, pixels: png.pixels };
  const problems = [];
  if (pixelAt(pixels, 0, 0)[3] !== 0) problems.push("icon corner is not transparent");
  const [r, g, b, a] = pixelAt(pixels, Math.round(size / 20), Math.round(size / 2));
  if (a !== 255 || r !== TILE_RGB[0] || g !== TILE_RGB[1] || b !== TILE_RGB[2]) {
    problems.push("icon tile does not fill the image");
  }
  return problems;
}

/**
 * Render `svg` to a PNG with headless Chrome and return the PNG bytes.
 * @param {string} svg
 * @param {{ chrome?: string | undefined, size?: number | undefined }} [options]
 * @returns {Buffer}
 */
export function renderIcon(svg, options = {}) {
  const chrome = options.chrome ?? defaultChromePath();
  const size = options.size ?? ICON_SIZE;
  const work = mkdtempSync(join(tmpdir(), "orbitrace-icon-"));
  try {
    const page = join(work, "icon.html");
    const out = join(work, "icon.png");
    const profile = join(work, "profile");
    writeFileSync(page, iconPage(svg, size));
    const result = spawnSync(chrome, chromeArgs({ page, out, profile, size }), {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 60_000,
    });
    if (result.error) throw new Error(`could not start Chrome (${result.error.message})`);
    if (!existsSync(out)) throw new Error(`Chrome wrote no screenshot (exit ${result.status})`);
    return readFileSync(out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Parse the arguments (without node and the script path).
 * @param {string[]} args
 * @returns {{ check: boolean, chrome: string | undefined }}
 */
export function parseArgs(args) {
  const options = { check: false, chrome: /** @type {string | undefined} */ (undefined) };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--check") options.check = true;
    else if (args[i] === "--chrome" && args[i + 1] !== undefined) {
      options.chrome = args[i + 1];
      i += 1;
    } else throw new Error("usage: build-icon.mjs [--check] [--chrome <path>]");
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.check) {
      const problems = existsSync(ICON_PNG)
        ? iconProblems(readFileSync(ICON_PNG))
        : ["media/icon.png is missing"];
      for (const problem of problems) console.error(`build-icon: ${problem}`);
      if (problems.length > 0) process.exitCode = 1;
      else console.log("build-icon: media/icon.png is a valid icon");
      return;
    }
    const png = renderIcon(readFileSync(SOURCE_SVG, "utf8"), { chrome: options.chrome });
    const problems = iconProblems(png);
    if (problems.length > 0)
      throw new Error(`the render is not a valid icon: ${problems.join("; ")}`);
    writeFileSync(ICON_PNG, png);
    console.log(
      `build-icon: wrote media/icon.png (${ICON_SIZE}x${ICON_SIZE}, ${png.length} bytes)`,
    );
  } catch (error) {
    console.error(`build-icon: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
