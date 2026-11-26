/**
 * Static files of the loopback server: the built web app from `appBundleDir()`.
 *
 * The files hold no user data, so they are served without the token, but the path of a request
 * must never reach a file outside the app folder. A request path is decoded once, split into
 * segments and refused when any segment is empty, `.`, `..`, hidden (starts with a dot) or
 * holds a backslash or a NUL. The joined path must stay inside the folder, and so must its real
 * path after symlinks are followed. Only regular files are served.
 */

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { APP_INDEX_FILE } from "../app-bundle.js";

/** Content type by file extension. Anything else is sent as `application/octet-stream`. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** The content type of a file name. */
export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** Largest static file served. The app's biggest file is well under 1 MB. */
export const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The path segments of a request target, or `null` when it must be refused. `/` is the index
 * page. The query string is ignored.
 */
export function requestSegments(target: string): string[] | null {
  if (!target.startsWith("/")) return null;
  const end = target.search(/[?#]/);
  const encoded = end === -1 ? target : target.slice(0, end);
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (decoded === "/") return [APP_INDEX_FILE];
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment.startsWith(".")) return null;
    // A drive letter or a colon is never part of the app's file names.
    if (segment.includes(":")) return null;
  }
  return segments;
}

/** Whether `child` is `root` itself or inside it. Both must be absolute and normalized. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface StaticFile {
  /** File name, for the content type. */
  readonly name: string;
  readonly data: Buffer;
}

/**
 * Read the file a request target names under `realRoot` (the app folder's real path), or
 * return `null` when the target is refused or names no regular file inside the folder.
 */
export async function readStaticFile(realRoot: string, target: string): Promise<StaticFile | null> {
  const segments = requestSegments(target);
  if (segments === null) return null;
  const joined = join(realRoot, ...segments);
  if (!isInside(realRoot, joined)) return null;
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    return null;
  }
  // A symlink inside the folder that points outside it is refused here.
  if (!isInside(realRoot, real) || real === realRoot) return null;
  // O_NOFOLLOW: if the last segment was swapped for a symlink after the check, opening fails.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_STATIC_FILE_BYTES) return null;
    const data = await handle.readFile();
    return { name: segments[segments.length - 1] as string, data };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
