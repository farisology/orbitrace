// @vitest-environment node
// Layout rules of the player frame behind reflow (WCAG 1.4.10) and resize text (1.4.4), read from
// src/player/player.css. happy-dom lays nothing out and the axe tests cannot see clipping, so these
// guard the rules that were measured in headless Chrome (the player scrolls like the app below
// 820 px wide or 480 px tall, and the start panel scrolls inside main) against being undone.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appCss, declaration, mediaBlock, rule, topLevel } from "../css";

const NARROW = "(max-width: 820px), (max-height: 480px)";

const playerCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "player", "player.css"),
  "utf8",
);
const playerTop = topLevel(playerCss);

describe("the player frame gives way to the page scroll on small screens", () => {
  it("uses the same narrow breakpoint as the app", () => {
    expect(() => mediaBlock(NARROW, appCss)).not.toThrow();
    expect(() => mediaBlock(NARROW, playerCss)).not.toThrow();
  });

  it("the frame grows with its content and stops hiding what overflows", () => {
    const narrow = mediaBlock(NARROW, playerCss);
    const frame = rule(".player", narrow);
    expect(declaration(frame, "height")).toBe("auto");
    expect(declaration(frame, "min-height")).toBe("100%");
    expect(declaration(frame, "overflow")).toBe("visible");
  });

  it("the app inside it is no longer squeezed to the window height", () => {
    const narrow = mediaBlock(NARROW, playerCss);
    expect(narrow).toMatch(/\.player > \.player-app,\s*\.player-app > \.app\s*\{/);
    expect(declaration(rule(".player-app > .app", narrow), "flex")).toBe("1 0 auto");
  });

  it("comes after the fixed-height rules it overrides", () => {
    const media = playerCss.indexOf(`@media ${NARROW}`);
    expect(media).toBeGreaterThan(playerCss.indexOf(".player {"));
    expect(media).toBeGreaterThan(playerCss.indexOf(".player-app > .app {"));
  });
});

describe("the start panel is never clipped", () => {
  // app.css now centres every message page in one cell (#154), so the player has no override.
  it("the player no longer overrides the app's message page", () => {
    expect(playerTop).not.toMatch(/app-main-message/);
  });

  it("main scrolls when the panel is taller than it (a long problem list, a short window)", () => {
    expect(declaration(rule(".app-main.app-main-message"), "overflow-y")).toBe("auto");
  });

  it("the panel is centred with auto margins, so its top stays reachable when it overflows", () => {
    expect(declaration(rule(".app-main-message > .message"), "margin")).toBe("auto");
  });
});
