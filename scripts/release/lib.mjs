// Shared helpers for the release scripts in this folder: the repository facts, the list of
// packages that are packed for a release, a small glob matcher, and wrappers around
// `npm pack`, `tar`, `unzip` and SHA-256.
//
// Nothing here publishes anything. `npm pack` writes a tarball to a folder; that is all.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root (two folders above this file). */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The public repository. Every published manifest points here. */
export const REPO_URL = "https://github.com/farisology/orbitrace";

/** `repository.url` in the form npm writes it, so `npm publish` does not rewrite it. */
export const REPO_GIT_URL = `git+${REPO_URL}.git`;

/** Where the pinned packaging tools (vsce, ovsx) are installed: `npm ci` in that folder. */
export const TOOLS_DIR = join(REPO_ROOT, "scripts", "release", "tools");

/**
 * Files that never belong in a published artefact, whatever a package's allow-list says.
 * Each entry is tested against the path inside the artefact, with forward slashes.
 * @type {readonly { id: string, pattern: RegExp }[]}
 */
export const DENIED_PATHS = [
  {
    id: "test-or-fixture-folder",
    pattern:
      /(^|\/)(test|tests|__tests__|test-integration|fixtures|coverage|node_modules|demo|spikes)\//,
  },
  { id: "test-file", pattern: /\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/ },
  { id: "transcript", pattern: /\.jsonl$/ },
  { id: "build-info", pattern: /\.tsbuildinfo$/ },
  { id: "env-file", pattern: /(^|\/)\.env(\.|$)/ },
  { id: "archive-or-log", pattern: /\.(tgz|vsix|log|db|sqlite)$/ },
  {
    id: "build-config",
    pattern: /(^|\/)(tsconfig[^/]*\.json|vitest\.config\.[^/]+|vite\.config\.[^/]+)$/,
  },
  { id: "privacy-denylist", pattern: /(^|\/)\.privacy-denylist/ },
];

/**
 * The npm packages a release packs, and what each tarball may contain.
 *
 * `allow`: every file in the tarball must match one of these globs (`*` stays inside one
 * folder, `**` crosses folders). `require`: files that must be there besides the ones the
 * manifest names (main, types, bin, exports), which are always required.
 *
 * Source maps: core and renderer build without them (tsconfig.build.json), so no map can point
 * at `src/`, which they do not ship. The CLI's build still writes maps (its tsconfig belongs to
 * the CLI), so it ships `src/` beside them and every map resolves inside the tarball. See
 * docs/releasing.md.
 * @type {readonly { dir: string, name: string, allow: readonly string[], require: readonly string[] }[]}
 */
export const NPM_PACKAGES = [
  {
    dir: "core",
    name: "@orbitrace/core",
    allow: [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/**/*.js",
      "dist/**/*.d.ts",
      "schema/replay-v1.schema.json",
    ],
    require: ["README.md", "LICENSE", "schema/replay-v1.schema.json"],
  },
  {
    dir: "renderer",
    name: "@orbitrace/renderer",
    allow: ["package.json", "README.md", "LICENSE", "dist/**/*.js", "dist/**/*.d.ts"],
    require: ["README.md", "LICENSE"],
  },
  {
    dir: "cli",
    name: "orbitrace",
    allow: [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/**/*.js",
      "dist/**/*.d.ts",
      "dist/**/*.js.map",
      "dist/**/*.d.ts.map",
      "dist/app/index.html",
      "dist/app/*.svg",
      "dist/app/assets/*.js",
      "dist/app/assets/*.css",
      "src/**/*.ts",
    ],
    require: ["README.md", "LICENSE", "dist/app/index.html"],
  },
];

/** The VS Code extension, packed with vsce into a .vsix. */
export const VSIX_PACKAGE = {
  dir: "vscode",
  name: "orbitrace-vscode",
  allow: [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/dist/extension.js",
    "extension/dist/app/index.html",
    "extension/dist/app/*.svg",
    "extension/dist/app/assets/*.js",
    "extension/dist/app/assets/*.css",
    "extension/media/*.svg",
  ],
  require: [
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/dist/extension.js",
    "extension/dist/app/index.html",
  ],
};

/**
 * Turn a glob into an anchored regular expression. `**` matches across folders (including
 * none: `dist/**\/*.js` matches `dist/a.js`), `*` matches within one folder, `?` one
 * character. Every other character is literal.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:[^/]+/)*";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Every file below `dir`, as paths relative to it with forward slashes, with sizes in bytes,
 * sorted by path.
 * @param {string} dir
 * @returns {{ path: string, size: number }[]}
 */
export function listTree(dir) {
  /** @type {{ path: string, size: number }[]} */
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.push({ path: relative(dir, full).split(sep).join("/"), size: statSync(full).size });
      }
    }
  };
  walk(dir);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * SHA-256 of a file, as lower-case hex.
 * @param {string} file
 */
export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Run `npm pack` in a package folder and write the tarball into `destDir`.
 * Lifecycle scripts (prepack, postpack) run as they would on `npm publish`.
 * @param {string} packageDir
 * @param {string} destDir
 * @returns {{ name: string, version: string, filename: string, path: string, size: number, unpackedSize: number, entryCount: number }}
 */
export function packNpm(packageDir, destDir) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", destDir], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const start = output.indexOf("[");
  if (start < 0) throw new Error(`npm pack printed no JSON in ${packageDir}`);
  const [info] = JSON.parse(output.slice(start));
  return {
    name: info.name,
    version: info.version,
    filename: info.filename,
    path: join(destDir, info.filename),
    size: info.size,
    unpackedSize: info.unpackedSize,
    entryCount: info.entryCount,
  };
}

/**
 * Unpack an npm tarball into `destDir` and return the package folder inside it.
 * @param {string} tarball
 * @param {string} destDir
 */
export function extractTarball(tarball, destDir) {
  execFileSync("tar", ["-xzf", tarball, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
  return join(destDir, "package");
}

/**
 * Unpack a zip archive (a .vsix) into `destDir`.
 * @param {string} archive
 * @param {string} destDir
 */
export function extractZip(archive, destDir) {
  execFileSync("unzip", ["-q", "-o", archive, "-d", destDir], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return destDir;
}

/**
 * True when `child` is `parent` or inside it.
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Format a byte count for a report: bytes below 1 KiB, then KiB with one decimal.
 * @param {number} bytes
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
