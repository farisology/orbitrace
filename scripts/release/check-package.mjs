#!/usr/bin/env node
// Packs each npm package that a release ships (core, renderer, cli) into a temporary folder,
// unpacks the tarball, and checks what is inside against the package's allow-list:
//
//   node scripts/release/check-package.mjs           check, print each file list and size
//   node scripts/release/check-package.mjs --json    the same report as JSON
//
// Run `npm run build` at the repository root first: the tarballs are made from dist/.
// Exits 1 when any package has an error. The temporary folder is deleted afterwards.
//
// The checks (checkArtefact below) are shared with pack-release.mjs, which also checks the
// .vsix. A finding never prints the text it matched, only the file and the rule, so a failing
// check cannot leak a value into a log.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODULE_LIST_FILE,
  MODULE_LIST_FORMAT,
  NOTICES_FILE,
  parseModuleList,
  parseNoticedPackages,
} from "../../packages/app/scripts/third-party-notices.mjs";
import { RULES, scanText } from "../privacy-check.mjs";
import {
  DENIED_PATHS,
  NPM_PACKAGES,
  REPO_GIT_URL,
  REPO_ROOT,
  REPO_URL,
  VSIX_PACKAGE,
  extractTarball,
  formatSize,
  globToRegExp,
  listTree,
  packNpm,
} from "./lib.mjs";

const BINARY_PROBE_BYTES = 8000;
const TEXT_EXTENSIONS =
  /\.(js|cjs|mjs|ts|mts|cts|map|json|md|txt|html|css|svg|xml|vsixmanifest)$|(^|\/)LICENSE$/;

/**
 * Files that fail the allow-list or match a denied path.
 * @param {readonly string[]} paths paths inside the artefact
 * @param {readonly string[]} allow globs
 * @returns {string[]} errors
 */
export function checkPaths(paths, allow) {
  const patterns = allow.map(globToRegExp);
  const errors = [];
  for (const path of paths) {
    const denied = DENIED_PATHS.find((rule) => rule.pattern.test(path));
    if (denied) errors.push(`${path}: not allowed in a published artefact (${denied.id})`);
    else if (!patterns.some((pattern) => pattern.test(path))) {
      errors.push(`${path}: not in the allow-list`);
    }
  }
  return errors;
}

/**
 * Every file path a manifest names as an entry point: main, types, bin and the targets of
 * exports. Wildcard export targets are skipped. Paths are normalised (no leading "./").
 * @param {Record<string, unknown>} manifest
 * @returns {string[]}
 */
export function entryPoints(manifest) {
  /** @type {string[]} */
  const targets = [];
  const add = (value) => {
    if (typeof value === "string") targets.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(add);
  };
  add(manifest.main);
  add(manifest.types);
  add(manifest.bin);
  add(manifest.exports);
  return [
    ...new Set(
      targets.filter((target) => !target.includes("*")).map((target) => posix.normalize(target)),
    ),
  ].sort();
}

/**
 * Check the packaging metadata of a manifest.
 * @param {Record<string, any>} manifest
 * @param {{ dir: string, name: string }} spec
 * @param {Map<string, { version: string, private: boolean }>} workspaces every workspace by name
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkManifest(manifest, spec, workspaces) {
  const errors = [];
  const warnings = [];
  if (manifest.name !== spec.name) errors.push(`package.json: name is not ${spec.name}`);
  if (typeof manifest.version !== "string" || manifest.version === "") {
    errors.push("package.json: no version");
  }
  if (manifest.license !== "MIT") errors.push("package.json: license is not MIT");
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    errors.push("package.json: no description");
  }
  const repository = manifest.repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    repository.type !== "git" ||
    repository.url !== REPO_GIT_URL ||
    repository.directory !== `packages/${spec.dir}`
  ) {
    errors.push(
      `package.json: repository must be { type: "git", url: "${REPO_GIT_URL}", directory: "packages/${spec.dir}" }`,
    );
  }
  const homepage = `${REPO_URL}/tree/main/packages/${spec.dir}#readme`;
  if (manifest.homepage !== homepage) errors.push(`package.json: homepage is not ${homepage}`);
  if (!manifest.bugs || manifest.bugs.url !== `${REPO_URL}/issues`) {
    errors.push(`package.json: bugs.url is not ${REPO_URL}/issues`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push("package.json: no files allow-list");
  }
  if (manifest.private === true) {
    warnings.push("package.json: private is true, so npm will refuse to publish this package");
  }
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    const workspace = workspaces.get(name);
    if (!workspace) continue;
    if (workspace.private) {
      errors.push(`package.json: depends on ${name}, a private workspace package`);
    }
    if (range !== manifest.version) {
      errors.push(
        `package.json: depends on ${name}@${range}; workspace packages share one version`,
      );
    }
  }
  return { errors, warnings };
}

/**
 * Check every source map and every sourceMappingURL comment against the files in the
 * artefact: a map's sources must be shipped (or embedded as sourcesContent), and a comment
 * must point at a shipped map.
 * @param {string} root the unpacked artefact
 * @param {ReadonlySet<string>} paths
 * @returns {string[]} errors
 */
export function checkSourceMaps(root, paths) {
  const errors = [];
  for (const path of paths) {
    if (path.endsWith(".map")) {
      let map;
      try {
        map = JSON.parse(readFileSync(join(root, path), "utf8"));
      } catch {
        errors.push(`${path}: not a valid source map`);
        continue;
      }
      const sources = Array.isArray(map.sources) ? map.sources : [];
      const base = posix.join(
        posix.dirname(path),
        typeof map.sourceRoot === "string" ? map.sourceRoot : "",
      );
      sources.forEach((source, index) => {
        if (typeof map.sourcesContent?.[index] === "string") return;
        if (typeof source !== "string" || /^[a-z]+:/i.test(source) || source.startsWith("/")) {
          errors.push(`${path}: source ${index} is not a relative path inside the package`);
          return;
        }
        const target = posix.normalize(posix.join(base, source));
        if (!paths.has(target)) errors.push(`${path}: points at ${target}, which is not shipped`);
      });
    } else if (/\.(c|m)?js$|\.d\.ts$|\.css$/.test(path)) {
      const text = readFileSync(join(root, path), "utf8");
      const match = /^(?:\/\/|\/\*)[#@] sourceMappingURL=([^\s*]+)/m.exec(text);
      if (!match || match[1].startsWith("data:")) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(match[1])));
      if (!paths.has(target)) {
        errors.push(`${path}: sourceMappingURL points at ${target}, which is not shipped`);
      }
    }
  }
  return errors;
}

/** A bare module specifier that names an npm package (with an optional subpath). */
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[\w.~-]+)*$/i;

/**
 * Every module specifier a JavaScript text imports: static `import`/`export ... from`,
 * side-effect `import "x"`, dynamic `import("x")` and `require("x")`. A static import must
 * start a line, as bundler and compiler output writes it.
 * @param {string} text
 * @returns {string[]} specifiers in the order found, with duplicates
 */
export function moduleSpecifiers(text) {
  const patterns = [
    /^[ \t]*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"'\n]+)["']/gm,
    /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
    /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
    /(?<![\w$.])require\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  /** @type {{ index: number, specifier: string }[]} */
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.push({ index: match.index ?? 0, specifier: match[1] });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.specifier);
}

/**
 * Check that a package installs alone: its manifest declares no dependencies, and each file
 * matching `globs` imports only Node.js built-ins and files shipped in the artefact. A finding
 * names a package specifier, but never a path-like one.
 * @param {string} root the unpacked artefact
 * @param {ReadonlySet<string>} paths
 * @param {readonly string[]} globs the files that run in Node
 * @param {Record<string, any>} manifest the shipped package.json
 * @returns {string[]} errors
 */
export function checkSelfContained(root, paths, globs, manifest) {
  const errors = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const count = Object.keys(manifest[field] ?? {}).length;
    if (count > 0) {
      errors.push(
        `package.json: declares ${count} ${field}; a self-contained package installs with none`,
      );
    }
  }
  const builtins = new Set(builtinModules);
  const patterns = globs.map(globToRegExp);
  const files = [...paths].filter((path) => patterns.some((pattern) => pattern.test(path)));
  if (files.length === 0) errors.push("no file matches the self-contained globs");
  for (const path of files) {
    const seen = new Set();
    for (const specifier of moduleSpecifiers(readFileSync(join(root, path), "utf8"))) {
      if (seen.has(specifier)) continue;
      seen.add(specifier);
      if (specifier.startsWith("node:") || builtins.has(specifier)) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!paths.has(target)) errors.push(`${path}: imports ${target}, which is not shipped`);
      } else if (PACKAGE_SPECIFIER.test(specifier)) {
        errors.push(`${path}: imports ${specifier}, which is not inside the tarball`);
      } else {
        errors.push(`${path}: imports a module that is neither a Node.js built-in nor shipped`);
      }
    }
  }
  return errors;
}

/**
 * Check the history worker of an unpacked .vsix (#211): `extension/dist/history-worker.js` loads
 * only Node.js built-ins and files shipped beside it (`VSIX_PACKAGE.selfContained`), so it starts
 * in a worker thread with nothing but the .vsix installed. Its presence is checked by
 * `VSIX_PACKAGE.require`; without the manifest there is nothing more to check here.
 * @param {string} root the unpacked .vsix
 * @param {readonly { path: string }[]} files its files (`listTree`)
 * @returns {string[]} errors
 */
export function checkVsixWorker(root, files) {
  const manifestPath = join(root, "extension", "package.json");
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const paths = new Set(files.map((file) => file.path));
  return checkSelfContained(root, paths, VSIX_PACKAGE.selfContained, manifest);
}

/**
 * Check every file the manifest's `bin` names: it starts with `#!/usr/bin/env node`, and, where
 * the platform has file modes, it is executable.
 * @param {string} root the unpacked artefact
 * @param {Record<string, any>} manifest
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]} errors
 */
export function checkBins(root, manifest, platform = process.platform) {
  const bin = manifest.bin;
  const targets =
    typeof bin === "string" ? [bin] : bin && typeof bin === "object" ? Object.values(bin) : [];
  const errors = [];
  for (const target of new Set(targets.filter((value) => typeof value === "string"))) {
    const path = posix.normalize(target);
    const full = join(root, path);
    if (!existsSync(full)) continue; // reported as a missing entry point
    if (!readFileSync(full, "utf8").startsWith("#!/usr/bin/env node\n")) {
      errors.push(`${path}: a bin file must start with #!/usr/bin/env node`);
    }
    if (platform !== "win32" && (statSync(full).mode & 0o111) === 0) {
      errors.push(`${path}: a bin file must be executable`);
    }
  }
  return errors;
}

/**
 * Scan the text files of an artefact with the repository's privacy rules, plus the build
 * machine's own folders as literal strings. Findings name the file, line and rule only.
 * @param {string} root
 * @param {readonly string[]} paths
 * @param {readonly string[]} literals strings that must not appear (for example the repository path)
 * @returns {string[]} errors
 */
export function checkContents(root, paths, literals) {
  const errors = [];
  const needles = literals.filter((value) => value.length >= 4);
  for (const path of paths) {
    if (!TEXT_EXTENSIONS.test(path)) continue;
    const buffer = readFileSync(join(root, path));
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) continue;
    const text = buffer.toString("utf8");
    for (const hit of scanText(text, RULES)) {
      errors.push(`${path}:${hit.line}: privacy rule ${hit.rule}`);
    }
    if (needles.some((needle) => text.includes(needle))) {
      errors.push(`${path}: contains a folder path of the build machine`);
    }
  }
  return errors;
}

/**
 * The folders of an artefact that hold the web app bundle: an `index.html` with at least one
 * `assets/*.js` beside it. "" is the artefact's root.
 * @param {ReadonlySet<string>} paths
 * @returns {string[]} folders, sorted
 */
export function webBundleDirs(paths) {
  const dirs = new Set();
  for (const path of paths) {
    const match = /^(?:(.+)\/)?assets\/[^/]+\.js$/.exec(path);
    if (!match) continue;
    const dir = match[1] ?? "";
    if (paths.has(dir === "" ? "index.html" : `${dir}/index.html`)) dirs.add(dir);
  }
  return [...dirs].sort();
}

/**
 * Read the module list beside a web app bundle, or describe why it cannot be used.
 * @param {string} file
 * @returns {{ list: ReturnType<typeof parseModuleList> } | { problem: string }}
 */
function readModuleList(file) {
  try {
    return { list: parseModuleList(readFileSync(file, "utf8")) };
  } catch {
    return { problem: `not a format ${MODULE_LIST_FORMAT} module list` };
  }
}

/**
 * Check the third-party notices of every web app bundle in an artefact (#143). Beside its
 * index.html there must be THIRD-PARTY-NOTICES.txt and the build's module list,
 * third-party-modules.json (both written by packages/app/scripts/third-party-notices.mjs);
 * every script of the bundle must be a chunk of that list, so the bundle, the list and the
 * notices come from one build; and the notices must name exactly the packages the list puts in
 * those scripts.
 * @param {string} root the unpacked artefact
 * @param {ReadonlySet<string>} paths
 * @returns {string[]} errors
 */
export function checkThirdPartyNotices(root, paths) {
  const errors = [];
  for (const dir of webBundleDirs(paths)) {
    const prefix = dir === "" ? "" : `${dir}/`;
    const notices = `${prefix}${NOTICES_FILE}`;
    const listPath = `${prefix}${MODULE_LIST_FILE}`;
    if (!paths.has(notices)) {
      errors.push(`${notices}: missing; the web app bundle beside it contains third-party code`);
    }
    if (!paths.has(listPath)) {
      errors.push(`${listPath}: missing; the notices beside it cannot be checked without it`);
    }
    if (!paths.has(notices) || !paths.has(listPath)) continue;
    const read = readModuleList(join(root, listPath));
    if ("problem" in read) {
      errors.push(`${listPath}: ${read.problem}`);
      continue;
    }
    const chunks = read.list.chunks;
    const assets = `${prefix}assets/`;
    const scripts = [...paths]
      .filter((path) => path.startsWith(assets) && /^[^/]+\.js$/.test(path.slice(assets.length)))
      .sort();
    const bundled = new Set();
    let complete = true;
    for (const path of scripts) {
      const chunk = path.slice(prefix.length);
      if (!Object.hasOwn(chunks, chunk)) {
        errors.push(
          `${path}: not in ${listPath}; the bundle and the list come from different builds`,
        );
        complete = false;
      } else chunks[chunk].forEach((id) => bundled.add(id));
    }
    const named = parseNoticedPackages(readFileSync(join(root, notices), "utf8"));
    for (const id of [...bundled].sort()) {
      if (!named.has(id)) errors.push(`${notices}: does not name ${id}, which is in the bundle`);
    }
    if (!complete) continue;
    for (const id of [...named].sort()) {
      if (!bundled.has(id)) {
        errors.push(`${notices}: names ${id}, which is not in the bundle (stale)`);
      }
    }
  }
  return errors;
}

/**
 * Check one unpacked artefact.
 * @param {string} root the unpacked folder (the `package/` folder of an npm tarball)
 * @param {{ allow: readonly string[], require: readonly string[] }} spec
 * @param {{ licenseText: string, licensePath: string, literals: readonly string[], extraRequired?: readonly string[] }} options
 * @returns {{ files: { path: string, size: number }[], errors: string[] }}
 */
export function checkArtefact(root, spec, options) {
  const files = listTree(root);
  const paths = new Set(files.map((file) => file.path));
  const errors = [...checkPaths([...paths], spec.allow)];
  for (const required of [...spec.require, ...(options.extraRequired ?? [])]) {
    if (!paths.has(required)) errors.push(`${required}: missing`);
  }
  if (paths.has(options.licensePath)) {
    const shipped = readFileSync(join(root, options.licensePath), "utf8");
    if (shipped.replace(/\r\n/g, "\n") !== options.licenseText.replace(/\r\n/g, "\n")) {
      errors.push(`${options.licensePath}: differs from the repository LICENSE`);
    }
  }
  if (paths.has("README.md") && readFileSync(join(root, "README.md"), "utf8").trim() === "") {
    errors.push("README.md: empty");
  }
  errors.push(...checkSourceMaps(root, paths));
  errors.push(...checkThirdPartyNotices(root, paths));
  errors.push(...checkContents(root, [...paths], options.literals));
  return { files, errors };
}

/**
 * Read every workspace manifest under packages/.
 * @param {string} root
 * @returns {Map<string, { version: string, private: boolean }>}
 */
export function readWorkspaceIndex(root) {
  const index = new Map();
  const packagesDir = join(root, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    index.set(manifest.name, { version: manifest.version, private: manifest.private === true });
  }
  return index;
}

/** Strings that must not appear in an artefact: the build machine's repository and home folders. */
export function buildMachineLiterals(root = REPO_ROOT) {
  return [resolve(root), homedir()];
}

/**
 * Pack one npm package into `destDir`, unpack it into `workDir`, and check it.
 * @param {{ dir: string, name: string, allow: readonly string[], require: readonly string[], selfContained?: readonly string[] }} spec
 * @param {{ root?: string, destDir: string, workDir: string, workspaces?: Map<string, { version: string, private: boolean }> }} options
 */
export function packAndCheck(spec, options) {
  const root = options.root ?? REPO_ROOT;
  const packageDir = join(root, "packages", spec.dir);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const tarball = packNpm(packageDir, options.destDir);
  const unpacked = extractTarball(tarball.path, mkdtempSync(join(options.workDir, `${spec.dir}-`)));
  const licenseText = readFileSync(join(root, "LICENSE"), "utf8");
  const shipped = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  const { errors: manifestErrors, warnings } = checkManifest(
    shipped,
    spec,
    options.workspaces ?? readWorkspaceIndex(root),
  );
  const { files, errors } = checkArtefact(unpacked, spec, {
    licenseText,
    licensePath: "LICENSE",
    literals: buildMachineLiterals(root),
    extraRequired: entryPoints(manifest),
  });
  errors.push(...checkBins(unpacked, shipped));
  if (spec.selfContained) {
    const paths = new Set(files.map((file) => file.path));
    errors.push(...checkSelfContained(unpacked, paths, spec.selfContained, shipped));
  }
  return {
    kind: "npm",
    name: spec.name,
    dir: spec.dir,
    version: shipped.version,
    private: shipped.private === true,
    file: tarball.filename,
    path: tarball.path,
    size: tarball.size,
    unpackedSize: tarball.unpackedSize,
    files,
    errors: [...manifestErrors, ...errors],
    warnings,
  };
}

/**
 * A plain-text report of checked artefacts: one block per artefact with its file list.
 * @param {{ name: string, file: string, size: number, files: { path: string, size: number }[], errors: string[], warnings: string[] }[]} reports
 */
export function formatReport(reports) {
  const lines = [];
  for (const report of reports) {
    const unpacked = report.files.reduce((sum, file) => sum + file.size, 0);
    lines.push(
      `${report.name}  ${report.file}  ${formatSize(report.size)} packed, ${formatSize(unpacked)} unpacked, ${report.files.length} files`,
    );
    for (const file of report.files)
      lines.push(`  ${file.path.padEnd(56)} ${formatSize(file.size)}`);
    for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
    for (const error of report.errors) lines.push(`  error: ${error}`);
    lines.push(report.errors.length === 0 ? "  ok" : `  ${report.errors.length} error(s)`);
    lines.push("");
  }
  return lines.join("\n");
}

function main() {
  const json = process.argv.includes("--json");
  const destDir = mkdtempSync(join(tmpdir(), "orbitrace-pack-"));
  try {
    const workspaces = readWorkspaceIndex(REPO_ROOT);
    const reports = NPM_PACKAGES.map((spec) =>
      packAndCheck(spec, { destDir, workDir: destDir, workspaces }),
    );
    const failed = reports.filter((report) => report.errors.length > 0);
    if (json) {
      const strip = reports.map(({ path: _path, ...rest }) => rest);
      process.stdout.write(`${JSON.stringify(strip, null, 2)}\n`);
    } else {
      process.stdout.write(formatReport(reports));
      process.stdout.write(
        failed.length === 0
          ? `check-package: ${reports.length} tarball(s) ok\n`
          : `check-package: ${failed.length} of ${reports.length} tarball(s) failed\n`,
      );
    }
    if (failed.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`check-package: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    rmSync(destDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) main();
