// Types for third-party-notices.mjs, so vite.config.ts can import it under `npm run typecheck`.
import type { Plugin } from "vite";

export declare const NOTICES_FILE: "THIRD-PARTY-NOTICES.txt";
export declare const MODULE_LIST_FILE: "third-party-modules.json";
export declare const MODULE_LIST_FORMAT: 1;
export declare const ALLOWED_LICENSES: readonly string[];
export declare const VIRTUAL_PROVIDERS: readonly {
  prefix: string;
  name: string;
  via: string | null;
}[];
export declare const GENERATED_CODE_NOTE: string;
export declare const PACKAGE_HEADING: "Package: ";

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  files: { file: string; text: string; trimmed: boolean }[];
}

export interface BundleChunk {
  fileName: string;
  modules: readonly { id: string; renderedLength: number }[];
}

export interface CollectedBundle {
  packages: BundledPackage[];
  chunks: Record<string, string[]>;
}

export interface ModuleList {
  format: number;
  packages: { name: string; version: string; license: string }[];
  chunks: Record<string, string[]>;
}

export interface NoticesOptions {
  /** The repository root: files inside it and outside node_modules are first-party. */
  repoRoot: string;
  /** The app package folder, where installed packages are looked up from. */
  appDir: string;
  allowed?: readonly string[];
}

export declare function compareCodePoints(a: string, b: string): number;
export declare function packageOfPath(path: string): { name: string; dir: string } | null;
export declare function findPackageDir(name: string, from: string): string | null;
export declare function classifyModule(
  id: string,
  options: NoticesOptions,
): { kind: "first-party" } | { kind: "package"; dir: string };
export declare function licenseExpression(manifest: Record<string, unknown>): string | null;
export declare function isLicenseAllowed(expression: string, allowed?: readonly string[]): boolean;
export declare function ownLicenseText(text: string): { text: string; trimmed: boolean };
export declare function readBundledPackage(
  dir: string,
  allowed?: readonly string[],
): BundledPackage;
export declare function collectBundle(
  chunks: readonly BundleChunk[],
  options: NoticesOptions,
): CollectedBundle;
export declare function renderNotices(packages: readonly BundledPackage[]): string;
export declare function renderModuleList(bundle: CollectedBundle): string;
export declare function parseNoticedPackages(text: string): Set<string>;
export declare function parseModuleList(text: string): ModuleList;
export declare function thirdPartyNotices(
  options: NoticesOptions & {
    /** Also write third-party-modules.json (the app build; the player build does not). */
    moduleList: boolean;
  },
): Plugin;
