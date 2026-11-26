import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/commands.js";
import { SESSIONS_VIEW } from "../src/extension.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = join(packageDir, "..", "..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
const INDEPENDENCE =
  "Orbitrace is an independent project. It is not affiliated with or endorsed by Anthropic.";

describe("package.json manifest", () => {
  it("uses the listing spelling and the independence statement", () => {
    expect(manifest.displayName).toContain("Visualizer");
    expect(manifest.description).toContain(INDEPENDENCE);
    expect(readFileSync(join(repoDir, "docs", "legal", "trademarks.md"), "utf8")).toContain(
      INDEPENDENCE,
    );
    for (const field of [manifest.name, manifest.displayName]) {
      expect(field).not.toMatch(/claude|anthropic|orrery/i);
    }
  });

  it("targets VS Code 1.96 or later with matching API types", () => {
    expect(manifest.engines.vscode).toBe("^1.96.0");
    expect(manifest.devDependencies["@types/vscode"]).toBe("1.96.0");
  });

  it("runs on the machine where the sessions are", () => {
    expect(manifest.extensionKind).toEqual(["workspace"]);
    expect(manifest.capabilities.virtualWorkspaces.supported).toBe(false);
  });

  it("activates only on the Sessions view and its commands", () => {
    expect(manifest.activationEvents).toEqual([
      `onView:${SESSIONS_VIEW}`,
      ...Object.values(COMMANDS).map((command) => `onCommand:${command}`),
    ]);
  });

  it("contributes the three commands with their palette titles, and refresh", () => {
    const titles = Object.fromEntries(
      manifest.contributes.commands.map(
        (command: { command: string; category: string; title: string }) => [
          command.command,
          `${command.category}: ${command.title}`,
        ],
      ),
    );
    expect(titles).toEqual({
      [COMMANDS.visualiseCurrent]: "Orbitrace: Visualise current session",
      [COMMANDS.visualiseSession]: "Orbitrace: Visualise session...",
      [COMMANDS.openDemo]: "Orbitrace: Open demo",
      [COMMANDS.refreshSessions]: "Orbitrace: Refresh sessions",
    });
  });

  it("has an activity-bar container with the Sessions view, a Visualise title button and a welcome message", () => {
    const [container] = manifest.contributes.viewsContainers.activitybar;
    expect(container.icon).toBe("media/activity-bar.svg");
    expect(existsSync(join(packageDir, container.icon))).toBe(true);
    expect(manifest.contributes.views[container.id].map((view: { id: string }) => view.id)).toEqual(
      [SESSIONS_VIEW],
    );
    const titleCommands = manifest.contributes.menus["view/title"].map(
      (item: { command: string }) => item.command,
    );
    expect(titleCommands).toContain(COMMANDS.visualiseCurrent);
    const welcome = manifest.contributes.viewsWelcome.find(
      (item: { view: string }) => item.view === SESSIONS_VIEW,
    );
    expect(welcome.contents).toContain(`command:${COMMANDS.openDemo}`);
  });

  it("ships only the bundle, the app, the icon, the licence and the readme", () => {
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.files).toEqual([
      "dist/extension.js",
      "dist/app",
      "media",
      "LICENSE",
      "README.md",
    ]);
    expect(existsSync(join(packageDir, ".vscodeignore"))).toBe(false);
  });

  it("builds after core and the app in the workspace build", async () => {
    // The root script that orders `npm run build`. Loaded by URL so this package's type check
    // does not take in a root file.
    const runner = await import(pathToFileURL(join(repoDir, "scripts", "run-workspaces.mjs")).href);
    const order: string[] = runner.orderWorkspaces(runner.readWorkspaces(repoDir));
    const at = (name: string): number => order.indexOf(name);
    expect(at(manifest.name)).toBeGreaterThan(at("@orbitrace/core"));
    expect(at(manifest.name)).toBeGreaterThan(at("@orbitrace/app"));
  });
});
