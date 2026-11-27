/**
 * The user's reduced-motion preference, kept up to date.
 *
 * Two sources: the `prefers-reduced-motion: reduce` media query (the operating system setting),
 * and in an editor tab the `vscode-reduce-motion` class the editor's webview puts on `<body>`
 * when its own reduce-motion setting is on. Either one turns reduced motion on.
 */

import { useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Class the VS Code webview adds to `<body>` when the editor asks for reduced motion. */
export const EDITOR_REDUCED_MOTION_CLASS = "vscode-reduce-motion";

function mediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

function body(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.body;
}

/** True when the user asked for reduced motion right now. */
export function prefersReducedMotion(): boolean {
  if (mediaQuery()?.matches === true) return true;
  return body()?.classList.contains(EDITOR_REDUCED_MOTION_CLASS) ?? false;
}

function subscribe(onChange: () => void): () => void {
  const query = mediaQuery();
  query?.addEventListener("change", onChange);
  const target = body();
  const observer =
    target === null || typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(onChange);
  if (observer !== null && target !== null) {
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    query?.removeEventListener("change", onChange);
    observer?.disconnect();
  };
}

/** Re-renders when the preference changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
