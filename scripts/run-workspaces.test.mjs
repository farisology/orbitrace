// Tests for scripts/run-workspaces.mjs. The fixture names are synthetic.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orderWorkspaces, readWorkspaces } from "./run-workspaces.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

let tempRoot;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "run-workspaces-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writePackage(folder, manifest) {
  const dir = join(tempRoot, "packages", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
}

describe("orderWorkspaces", () => {
  it("puts a dependency before the workspace that imports it, whatever the folder order", () => {
    // "alpha" sorts first but depends on "zeta", so "zeta" must run first.
    const order = orderWorkspaces([
      { name: "alpha", dependsOn: ["zeta"] },
      { name: "zeta", dependsOn: [] },
    ]);
    expect(order).toEqual(["zeta", "alpha"]);
  });

  it("orders a chain of three workspaces", () => {
    const order = orderWorkspaces([
      { name: "app", dependsOn: ["renderer", "core"] },
      { name: "renderer", dependsOn: ["core"] },
      { name: "core", dependsOn: [] },
    ]);
    expect(order.indexOf("core")).toBeLessThan(order.indexOf("renderer"));
    expect(order.indexOf("renderer")).toBeLessThan(order.indexOf("app"));
  });

  it("ignores dependencies that are not workspaces", () => {
    const order = orderWorkspaces([
      { name: "one", dependsOn: ["react", "@types/node"] },
      { name: "two", dependsOn: [] },
    ]);
    expect(order).toEqual(["one", "two"]);
  });

  it("throws on a dependency cycle and names the cycle", () => {
    expect(() =>
      orderWorkspaces([
        { name: "left", dependsOn: ["right"] },
        { name: "right", dependsOn: ["left"] },
      ]),
    ).toThrow("workspace dependency cycle");
  });
});

describe("readWorkspaces", () => {
  it("reads dependencies and devDependencies from each packages/* manifest", () => {
    writePackage("base", { name: "@synthetic/base" });
    writePackage("top", {
      name: "@synthetic/top",
      dependencies: { "@synthetic/base": "0.0.0" },
      devDependencies: { vitest: "4.1.12" },
    });
    const workspaces = readWorkspaces(tempRoot);
    const top = workspaces.find((workspace) => workspace.name === "@synthetic/top");
    expect(top.dependsOn).toEqual(["@synthetic/base", "vitest"]);
    expect(orderWorkspaces(workspaces)).toEqual(["@synthetic/base", "@synthetic/top"]);
  });
});

describe("the real repository", () => {
  it("runs @orbitrace/core before the cli that imports it", () => {
    const workspaces = readWorkspaces(repoRoot);
    const order = orderWorkspaces(workspaces);
    expect(order.indexOf("@orbitrace/core")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("@orbitrace/core")).toBeLessThan(order.indexOf("orbitrace"));
  });

  it("runs every workspace after all of its workspace dependencies", () => {
    const workspaces = readWorkspaces(repoRoot);
    const order = orderWorkspaces(workspaces);
    const names = new Set(workspaces.map((workspace) => workspace.name));
    for (const workspace of workspaces) {
      for (const dep of workspace.dependsOn.filter((name) => names.has(name))) {
        expect(order.indexOf(dep)).toBeLessThan(order.indexOf(workspace.name));
      }
    }
  });
});
