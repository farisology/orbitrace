// Writes THIRD-PARTY-NOTICES.txt next to the web app bundle when the app is built (#143).
//
// vite.config.ts registers thirdPartyNotices() for the app build (dist/) and for the public
// player build (dist-player/). At the end of a build the plugin reads, for every output chunk,
// the modules the bundler actually put into it (modules that rendered no code are left out),
// maps each module to the installed package it came from, and writes:
//
//   THIRD-PARTY-NOTICES.txt   each third-party package's name, version, licence identifier and
//                             the full text of its licence file(s), sorted by name, plus a
//                             one-line note about the generated Ajv validator in @orbitrace/core;
//   third-party-modules.json  (app build only) which packages are in which chunk. The CLI and
//                             the extension copy it with the app, and the release check
//                             (scripts/release/check-package.mjs) compares the notices beside it
//                             with it in each artefact.
//
// The build fails when a bundled package declares no licence, has a licence outside
// ALLOWED_LICENSES, or has no licence file in its package folder, and when a bundled module
// comes from somewhere it cannot attribute (an unknown virtual module, or a file outside both
// the repository and node_modules).
//
// The output depends only on the bundle and the installed packages, never on the machine: no
// dates, no absolute paths, and every list is sorted by code point.
//
// No dependency: this file uses Node.js built-ins only, so the notices cost no new package.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The notices file, written next to index.html. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/** Which packages are in which chunk, for the release check (app build only). */
export const MODULE_LIST_FILE = "third-party-modules.json";

/** The version of the module list's JSON shape. */
export const MODULE_LIST_FORMAT = 1;

/**
 * Licences a bundled package may have, as SPDX identifiers. All permissive; none asks for more
 * than the notice and licence text this file ships (Apache-2.0 also asks for the package's
 * NOTICE file, which is copied when there is one). Today's bundle uses MIT only.
 */
export const ALLOWED_LICENSES = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

/**
 * Virtual modules (ids starting with "\0") and the package whose code they are. `via` names the
 * package to look the provider up from, when it is a dependency of that package rather than of
 * the app.
 * @type {readonly { prefix: string, name: string, via: string | null }[]}
 */
export const VIRTUAL_PROVIDERS = Object.freeze([
  // Vite's module preload polyfill and dynamic import helper.
  { prefix: "\0vite/", name: "vite", via: null },
  // The bundler's runtime helpers (for example the CommonJS interop React needs).
  { prefix: "\0rolldown/", name: "rolldown", via: "vite" },
]);

/** The one-line acknowledgement of generated code that is not a bundled package. */
export const GENERATED_CODE_NOTE =
  "The replay validator in @orbitrace/core is code generated ahead of time by Ajv (MIT licence, https://ajv.js.org) in its standalone mode; it imports no Ajv module, so no Ajv code is in this bundle.";

/** Starts the heading line of each package's block; the release check reads these lines. */
export const PACKAGE_HEADING = "Package: ";

const RULE = "-".repeat(80);

/** A heading that starts a package's list of the licences of its own bundled dependencies. */
const BUNDLED_DEPENDENCIES_HEADING = /^#{1,6}[ \t]+Licen[cs]es of bundled dependencies\b/im;

/** Licence files in a package folder: LICENSE, LICENCE.md, LICENSE-MIT, THIRD-PARTY-LICENSE, COPYING. */
const LICENSE_FILE = /^(?:[\w-]*[-_.])?licen[cs]e(?:[-_.][\w.-]*)?$|^copying(?:\.[\w]+)?$/i;

/** The NOTICE file that Apache-2.0 asks redistributors to carry along. */
const NOTICE_FILE = /^notice(?:\.(?:md|txt))?$/i;

/**
 * Compare two strings by UTF-16 code unit, independent of the machine's locale.
 * @param {string} a
 * @param {string} b
 */
export function compareCodePoints(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The installed package a file path belongs to: the folder after the last `node_modules`.
 * @param {string} path an absolute path
 * @returns {{ name: string, dir: string } | null} null when the path is not in node_modules
 */
export function packageOfPath(path) {
  const parts = path.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const first = parts[at + 1];
  if (first === undefined || first === "") return null;
  const count = first.startsWith("@") ? 2 : 1;
  if (at + count >= parts.length || parts[at + count] === "") return null;
  return {
    name: parts.slice(at + 1, at + 1 + count).join("/"),
    dir: parts.slice(0, at + 1 + count).join(sep),
  };
}

/**
 * Find an installed package the way Node does: `node_modules/<name>` in `from` or a parent.
 * @param {string} name
 * @param {string} from a folder
 * @returns {string | null} the package folder, with links resolved
 */
export function findPackageDir(name, from) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * True when `child` is `parent` or inside it.
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Where one bundled module comes from. Workspace packages are first-party: the bundler reports
 * them by their real path, and a linked path is resolved before it is classified.
 * @param {string} id the module id the bundler reports
 * @param {{ repoRoot: string, appDir: string }} options
 * @returns {{ kind: "first-party" } | { kind: "package", dir: string }}
 */
export function classifyModule(id, options) {
  const clean = id.split("?")[0] ?? id;
  if (clean.startsWith("\0")) {
    const provider = VIRTUAL_PROVIDERS.find((entry) => clean.startsWith(entry.prefix));
    if (!provider) {
      const label = JSON.stringify(clean.slice(1).split("/")[0] ?? "");
      throw new Error(
        `a virtual module from an unknown provider (${label}) was bundled. Find the package that provides it, review its licence and add it to VIRTUAL_PROVIDERS.`,
      );
    }
    const start =
      provider.via === null ? options.appDir : findPackageDir(provider.via, options.appDir);
    const dir = start === null ? null : findPackageDir(provider.name, start);
    if (dir === null) {
      throw new Error(
        `${provider.name}, which provides a bundled virtual module, is not installed`,
      );
    }
    return { kind: "package", dir };
  }
  if (!isAbsolute(clean)) {
    throw new Error("a bundled module id is neither a file path nor a known virtual module");
  }
  const real = existsSync(clean) ? realpathSync(clean) : clean;
  const pkg = packageOfPath(real);
  if (pkg) return { kind: "package", dir: pkg.dir };
  const root = existsSync(options.repoRoot) ? realpathSync(options.repoRoot) : options.repoRoot;
  if (isInside(root, real)) return { kind: "first-party" };
  throw new Error("a bundled module is outside both the repository and node_modules");
}

/**
 * The licence a manifest declares, as an SPDX expression: `license`, or the old `licenses`
 * array or `{ type }` object forms.
 * @param {Record<string, unknown>} manifest
 * @returns {string | null}
 */
export function licenseExpression(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim() !== "") return license.trim();
  if (license && typeof license === "object" && "type" in license) {
    const type = /** @type {{ type: unknown }} */ (license).type;
    if (typeof type === "string" && type.trim() !== "") return type.trim();
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((type) => typeof type === "string" && type.trim() !== "");
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return null;
}

/**
 * True when an SPDX expression is allowed: one allowed identifier, `A OR B` with at least one
 * allowed, or `A AND B` with all allowed. Anything more complex (nesting, mixed operators,
 * `WITH` exceptions, `LicenseRef-`) is refused, so a person reviews it.
 * @param {string} expression
 * @param {readonly string[]} [allowed]
 */
export function isLicenseAllowed(expression, allowed = ALLOWED_LICENSES) {
  const body = expression
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  if (/[()]/.test(body) || / WITH /i.test(body)) return false;
  const hasOr = / OR /i.test(body);
  const hasAnd = / AND /i.test(body);
  if (hasOr && hasAnd) return false;
  const ids = body.split(/ OR | AND /i).map((id) => id.trim());
  return hasAnd ? ids.every((id) => allowed.includes(id)) : ids.some((id) => allowed.includes(id));
}

/**
 * The part of a licence file that is the package's own licence. Some build tools append the
 * licences of the packages bundled into the tool itself under a "Licenses of bundled
 * dependencies" heading; that code is not in the web app bundle, so the section is left out.
 * @param {string} text
 * @returns {{ text: string, trimmed: boolean }}
 */
export function ownLicenseText(text) {
  const normal = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = BUNDLED_DEPENDENCIES_HEADING.exec(normal);
  if (match && match.index > 0)
    return { text: normal.slice(0, match.index).trimEnd(), trimmed: true };
  return { text: normal.trimEnd(), trimmed: false };
}

/**
 * Read one bundled package: name, version, licence and licence texts. Throws when the package
 * declares no licence, a licence outside `allowed`, or has no licence file.
 * @param {string} dir the package folder
 * @param {readonly string[]} [allowed]
 * @returns {{ name: string, version: string, license: string, files: { file: string, text: string, trimmed: boolean }[] }}
 */
export function readBundledPackage(dir, allowed = ALLOWED_LICENSES) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const { name, version } = manifest;
  if (typeof name !== "string" || name === "" || typeof version !== "string" || version === "") {
    throw new Error("a bundled package has no name or version in its package.json");
  }
  const id = `${name}@${version}`;
  const license = licenseExpression(manifest);
  if (license === null) throw new Error(`${id} declares no licence in its package.json`);
  if (!isLicenseAllowed(license, allowed)) {
    throw new Error(
      `${id} is licensed ${license}, which is not in the allow-list (${allowed.join(", ")}). Review it and add it to ALLOWED_LICENSES in packages/app/scripts/third-party-notices.mjs, or keep the package out of the bundle.`,
    );
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort(compareCodePoints);
  const licenseFiles = names.filter((file) => LICENSE_FILE.test(file));
  if (licenseFiles.length === 0) {
    throw new Error(
      `${id} has no licence file (LICENSE, LICENCE or COPYING) in its package folder`,
    );
  }
  const noticeFiles = /\bApache-2\.0\b/.test(license)
    ? names.filter((file) => NOTICE_FILE.test(file))
    : [];
  const files = [...licenseFiles, ...noticeFiles].map((file) => ({
    file,
    ...ownLicenseText(readFileSync(join(dir, file), "utf8")),
  }));
  return { name, version, license, files };
}

/**
 * Work out what third-party code a bundle holds.
 * @param {readonly { fileName: string, modules: readonly { id: string, renderedLength: number }[] }[]} chunks
 *   every output chunk with the modules in it
 * @param {{ repoRoot: string, appDir: string, allowed?: readonly string[] }} options
 * @returns {{ packages: ReturnType<typeof readBundledPackage>[], chunks: Record<string, string[]> }}
 *   packages sorted by name then version; for each chunk, the `name@version` of each package
 *   in it, sorted
 */
export function collectBundle(chunks, options) {
  /** @type {Map<string, ReturnType<typeof readBundledPackage>>} */
  const byDir = new Map();
  /** @type {Map<string, ReturnType<typeof readBundledPackage>>} */
  const byId = new Map();
  /** @type {Record<string, string[]>} */
  const perChunk = {};
  for (const chunk of [...chunks].sort((a, b) => compareCodePoints(a.fileName, b.fileName))) {
    const ids = new Set();
    for (const module of chunk.modules) {
      if (module.renderedLength === 0) continue;
      const origin = classifyModule(module.id, options);
      if (origin.kind !== "package") continue;
      let info = byDir.get(origin.dir);
      if (!info) {
        info = readBundledPackage(origin.dir, options.allowed);
        byDir.set(origin.dir, info);
      }
      const id = `${info.name}@${info.version}`;
      if (!byId.has(id)) byId.set(id, info);
      ids.add(id);
    }
    perChunk[chunk.fileName] = [...ids].sort(compareCodePoints);
  }
  const packages = [...byId.values()].sort(
    (a, b) => compareCodePoints(a.name, b.name) || compareCodePoints(a.version, b.version),
  );
  return { packages, chunks: perChunk };
}

/**
 * The text of THIRD-PARTY-NOTICES.txt.
 * @param {readonly ReturnType<typeof readBundledPackage>[]} packages sorted
 * @returns {string}
 */
export function renderNotices(packages) {
  const lines = [
    "Orbitrace web app: third-party notices",
    "",
    "The Orbitrace web app bundle (index.html and the assets folder beside this file) contains",
    "code from the third-party packages listed below. Each package's licence follows, copied from",
    "the licence file of the installed package. This file is generated when the app is built",
    "(packages/app/scripts/third-party-notices.mjs in the Orbitrace repository), from the modules",
    "the bundler put into the output.",
    "",
    "Orbitrace itself is released under the MIT licence: https://github.com/farisology/orbitrace",
    "Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.",
    "",
  ];
  if (packages.length === 0) lines.push("No third-party package code is in this bundle.");
  else {
    lines.push(`Packages (${packages.length}):`);
    for (const pkg of packages) lines.push(`  ${pkg.name}@${pkg.version} (${pkg.license})`);
  }
  lines.push("", "Generated code:", `  ${GENERATED_CODE_NOTE}`);
  for (const pkg of packages) {
    lines.push("", RULE, `${PACKAGE_HEADING}${pkg.name}@${pkg.version}`, `Licence: ${pkg.license}`);
    for (const entry of pkg.files) {
      lines.push(
        entry.trimmed
          ? `From: ${entry.file}, the package's own licence only. Its "Licenses of bundled dependencies" section is left out: it covers code bundled into ${pkg.name}'s own tools, none of which is in this bundle.`
          : `From: ${entry.file}`,
        "",
        entry.text,
        "",
      );
    }
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The text of third-party-modules.json.
 * @param {ReturnType<typeof collectBundle>} bundle
 * @returns {string}
 */
export function renderModuleList(bundle) {
  const doc = {
    format: MODULE_LIST_FORMAT,
    notices: NOTICES_FILE,
    packages: bundle.packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
    })),
    chunks: bundle.chunks,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Every `name@version` a notices file names in its package headings.
 * @param {string} text the notices file
 * @returns {Set<string>}
 */
export function parseNoticedPackages(text) {
  const names = new Set();
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith(PACKAGE_HEADING)) names.add(line.slice(PACKAGE_HEADING.length).trim());
  }
  return names;
}

/**
 * Read and check a module list.
 * @param {string} text the JSON text of third-party-modules.json
 * @returns {{ format: number, packages: { name: string, version: string, license: string }[], chunks: Record<string, string[]> }}
 */
export function parseModuleList(text) {
  const doc = JSON.parse(text);
  const fail = () => {
    throw new Error(`${MODULE_LIST_FILE} is not a format ${MODULE_LIST_FORMAT} module list`);
  };
  if (!doc || typeof doc !== "object" || doc.format !== MODULE_LIST_FORMAT) fail();
  if (!Array.isArray(doc.packages) || !doc.chunks || typeof doc.chunks !== "object") fail();
  for (const list of Object.values(doc.chunks)) {
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) fail();
  }
  return doc;
}

/**
 * The Vite plugin. It runs in production builds only (`apply: "build"`).
 * @param {{ repoRoot: string, appDir: string, moduleList: boolean, allowed?: readonly string[] }} options
 *   `moduleList`: also write third-party-modules.json (the app build; the player does not)
 */
export function thirdPartyNotices(options) {
  return {
    name: "orbitrace-third-party-notices",
    apply: /** @type {const} */ ("build"),
    /**
     * @this {{ emitFile: (file: { type: "asset", fileName: string, source: string }) => unknown, error: (message: string) => never }}
     * @param {unknown} _output
     * @param {Record<string, { type: string, fileName: string, moduleIds?: readonly string[], modules?: Record<string, { renderedLength: number }> }>} bundle
     */
    generateBundle(_output, bundle) {
      const chunks = Object.values(bundle)
        .filter((item) => item.type === "chunk")
        .map((chunk) => ({
          fileName: chunk.fileName,
          modules: (chunk.moduleIds ?? Object.keys(chunk.modules ?? {})).map((id) => ({
            id,
            renderedLength: chunk.modules?.[id]?.renderedLength ?? 1,
          })),
        }));
      let collected;
      try {
        collected = collectBundle(chunks, options);
      } catch (error) {
        this.error(
          `third-party notices: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.emitFile({
        type: "asset",
        fileName: NOTICES_FILE,
        source: renderNotices(collected.packages),
      });
      if (options.moduleList) {
        this.emitFile({
          type: "asset",
          fileName: MODULE_LIST_FILE,
          source: renderModuleList(collected),
        });
      }
    },
  };
}
