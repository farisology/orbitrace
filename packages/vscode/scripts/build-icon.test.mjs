// Tests for scripts/build-icon.mjs, the script that renders the listing icon (#22). Synthetic
// PNG files are built in memory; the render is tested with a fake Chrome (a small Node script),
// and with the real one only where it is installed at the default path.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ICON_PNG,
  ICON_SIZE,
  SOURCE_SVG,
  TILE_RGB,
  chromeArgs,
  defaultChromePath,
  hexToRgb,
  iconPage,
  iconProblems,
  parseArgs,
  pixelAt,
  readPng,
  renderIcon,
  unfilter,
} from "./build-icon.mjs";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A PNG file built from raw (already filtered) image data. CRCs are left at zero: the reader
 * does not check them.
 * @param {{ width: number, height: number, colorType?: number, bitDepth?: number, raw: Buffer }} image
 */
function pngFile({ width, height, colorType = 6, bitDepth = 8, raw }) {
  /** @type {(type: string, data: Buffer) => Buffer} */
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * An unfiltered (filter type 0) RGBA PNG of `size` pixels, coloured by `paint(x, y)`.
 * @param {number} size
 * @param {(x: number, y: number) => number[]} paint
 */
function rgbaPng(size, paint) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = [0];
    for (let x = 0; x < size; x += 1) row.push(...paint(x, y));
    rows.push(Buffer.from(row));
  }
  return pngFile({ width: size, height: size, raw: Buffer.concat(rows) });
}

/** A small icon that passes: transparent corners, the tile colour everywhere else. */
/** @type {(size: number) => Buffer} */
const goodIcon = (size) =>
  rgbaPng(size, (x, y) =>
    (x === 0 || x === size - 1) && (y === 0 || y === size - 1) ? [0, 0, 0, 0] : [...TILE_RGB, 255],
  );

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbitrace-icon-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("iconPage", () => {
  it("embeds the SVG as a data: URL at the icon size, and allows no other source", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>';
    const page = iconPage(svg, 64);
    expect(page).toContain(
      `src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"`,
    );
    expect(page).toContain('width="64" height="64"');
    expect(page).toContain("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    expect(page).toContain("margin:0");
    expect(page.replace(/data:[^"]+/, "")).not.toMatch(/https?:/);
  });
});

describe("chromeArgs", () => {
  it("runs headless with its own profile, at the icon size, with a transparent background", () => {
    const args = chromeArgs({
      page: join(dir, "icon.html"),
      out: join(dir, "icon.png"),
      profile: join(dir, "profile"),
      size: 128,
    });
    expect(args).toContain("--headless=new");
    expect(args).toContain("--default-background-color=00000000");
    expect(args).toContain("--force-device-scale-factor=1");
    expect(args).toContain("--window-size=128,128");
    expect(args).toContain(`--user-data-dir=${join(dir, "profile")}`);
    expect(args).toContain(`--screenshot=${join(dir, "icon.png")}`);
    expect(args.at(-1)).toMatch(/^file:\/\/.*icon\.html$/);
    expect(args.some((arg) => arg.startsWith("--remote-debugging"))).toBe(false);
  });
});

describe("defaultChromePath", () => {
  it("prefers CHROME_PATH, and otherwise uses the platform's usual path", () => {
    expect(defaultChromePath("linux", { CHROME_PATH: "/opt/chrome/chrome" })).toBe(
      "/opt/chrome/chrome",
    );
    expect(defaultChromePath("darwin", {})).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(defaultChromePath("win32", {})).toMatch(/chrome\.exe$/);
    expect(defaultChromePath("linux", {})).toBe("google-chrome");
  });
});

describe("hexToRgb", () => {
  it("reads #RRGGBB and refuses anything else", () => {
    expect(hexToRgb("#060714")).toEqual([6, 7, 20]);
    expect(hexToRgb("#FFfF00")).toEqual([255, 255, 0]);
    expect(() => hexToRgb("#fff")).toThrow("not a #RRGGBB colour");
  });

  it("gives the tile colour of the design tokens", () => {
    const tokens = JSON.parse(
      readFileSync(join(packageDir, "..", "..", "design", "tokens.json"), "utf8"),
    );
    expect(TILE_RGB).toEqual(hexToRgb(tokens.color.ground.void));
  });
});

describe("readPng, unfilter and pixelAt", () => {
  it("decodes each PNG filter type", () => {
    // A 2x5 image: one row per filter type. The expected pixels are decoded by hand below.
    const want = [
      [10, 20, 30, 40, 50, 60, 70, 80],
      [11, 22, 33, 44, 55, 66, 77, 88],
      [12, 24, 36, 48, 60, 72, 84, 96],
      [13, 26, 39, 52, 65, 78, 91, 104],
      [14, 28, 42, 56, 70, 84, 98, 112],
    ];
    /** @type {(a: number, b: number, c: number) => number} */
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    /** @type {(y: number, x: number) => number} */
    const at = (y, x) => (y >= 0 && x >= 0 ? (want[y]?.[x] ?? 0) : 0);
    /** @type {number[]} */
    const raw = [];
    want.forEach((row, y) => {
      const filter = y; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
      raw.push(filter);
      row.forEach((value, x) => {
        const a = at(y, x - 4);
        const b = at(y - 1, x);
        const c = at(y - 1, x - 4);
        const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0;
        raw.push((value - predictor + 256) & 0xff);
      });
    });
    const png = readPng(pngFile({ width: 2, height: 5, raw: Buffer.from(raw) }));
    expect(png).toMatchObject({ width: 2, height: 5, bitDepth: 8, colorType: 6, interlace: 0 });
    expect(png.pixels).not.toBeNull();
    const pixels = { width: 2, pixels: /** @type {Buffer} */ (png.pixels) };
    expect(pixelAt(pixels, 0, 0)).toEqual([10, 20, 30, 40]);
    expect(pixelAt(pixels, 1, 4)).toEqual([70, 84, 98, 112]);
    expect([...unfilter(Buffer.from(raw), 2, 5)]).toEqual(want.flat());
  });

  it("refuses a file that is not a PNG, and an unknown filter type", () => {
    expect(() => readPng(Buffer.from("GIF89a, not a PNG at all, long enough to read"))).toThrow(
      "not a PNG file",
    );
    expect(() => unfilter(Buffer.from([9, 0, 0, 0, 0]), 1, 1)).toThrow("unknown PNG filter type 9");
    expect(() => unfilter(Buffer.from([0, 0]), 1, 1)).toThrow("too short");
  });

  it("reads the header of another format without decoding its pixels", () => {
    const png = readPng(
      pngFile({ width: 1, height: 1, colorType: 2, raw: Buffer.from([0, 1, 2, 3]) }),
    );
    expect(png).toMatchObject({ width: 1, height: 1, colorType: 2, pixels: null });
  });
});

describe("iconProblems", () => {
  it("accepts an RGBA icon of the right size with transparent corners and a full tile", () => {
    expect(iconProblems(goodIcon(40), 40)).toEqual([]);
  });

  it("names each problem", () => {
    expect(iconProblems(Buffer.from("not an image"), 40)).toEqual(["not a PNG file"]);
    expect(iconProblems(goodIcon(20), 40)).toEqual(["icon is 20x20, expected 40x40"]);
    expect(
      iconProblems(
        pngFile({ width: 40, height: 40, colorType: 2, raw: Buffer.alloc(40 * 121) }),
        40,
      ),
    ).toEqual(["icon is not a non-interlaced 8-bit RGBA PNG"]);
    expect(
      iconProblems(
        rgbaPng(40, () => [...TILE_RGB, 255]),
        40,
      ),
    ).toEqual(["icon corner is not transparent"]);
    // A render at the wrong scale: the tile sits in the top-left corner only.
    expect(
      iconProblems(
        rgbaPng(40, (x, y) =>
          x > 0 && y > 0 && x < 10 && y < 10 ? [...TILE_RGB, 255] : [0, 0, 0, 0],
        ),
        40,
      ),
    ).toEqual(["icon tile does not fill the image"]);
  });

  it("accepts the committed icon that package.json names", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    expect(join(packageDir, manifest.icon)).toBe(ICON_PNG);
    expect(iconProblems(readFileSync(ICON_PNG))).toEqual([]);
    expect(SOURCE_SVG.endsWith(join("design", "icons", "favicon.svg"))).toBe(true);
  });
});

describe("parseArgs", () => {
  it("reads --check and --chrome, and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ check: false, chrome: undefined });
    expect(parseArgs(["--check"])).toEqual({ check: true, chrome: undefined });
    expect(parseArgs(["--chrome", "/opt/chrome"])).toEqual({ check: false, chrome: "/opt/chrome" });
    expect(() => parseArgs(["--chrome"])).toThrow("usage");
    expect(() => parseArgs(["--size", "64"])).toThrow("usage");
  });
});

describe.skipIf(process.platform === "win32")("renderIcon with a fake Chrome", () => {
  /**
   * Write an executable Node script that stands in for Chrome. With `png`, it copies that file to
   * the --screenshot path; without, it writes nothing.
   * @param {string | null} png
   */
  function fakeChrome(png) {
    const script = join(dir, "fake-chrome.mjs");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env node",
        'import { copyFileSync } from "node:fs";',
        'const out = process.argv.find((arg) => arg.startsWith("--screenshot="));',
        png === null
          ? ""
          : `copyFileSync(${JSON.stringify(png)}, out.slice("--screenshot=".length));`,
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    return script;
  }

  it("returns the PNG the browser wrote", () => {
    const source = join(dir, "source.png");
    writeFileSync(source, goodIcon(ICON_SIZE));
    const png = renderIcon("<svg/>", { chrome: fakeChrome(source) });
    expect(png.equals(goodIcon(ICON_SIZE))).toBe(true);
  });

  it("fails when the browser writes nothing or cannot start", () => {
    expect(() => renderIcon("<svg/>", { chrome: fakeChrome(null) })).toThrow(
      "Chrome wrote no screenshot",
    );
    expect(() => renderIcon("<svg/>", { chrome: join(dir, "no-such-browser") })).toThrow(
      "could not start Chrome",
    );
  });
});

describe.skipIf(!existsSync(defaultChromePath()))("renderIcon with Chrome", () => {
  it("renders the design mark as a valid icon", { timeout: 60_000 }, () => {
    const png = renderIcon(readFileSync(SOURCE_SVG, "utf8"));
    expect(iconProblems(png)).toEqual([]);
  });
});
