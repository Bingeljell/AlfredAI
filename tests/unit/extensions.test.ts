import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExtensionManager } from "../../src/extensions/manager.js";

async function managerFixture(): Promise<{ manager: ExtensionManager; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alfred-extensions-"));
  return { manager: new ExtensionManager(root), root };
}

test("extension scaffolds are disabled until an exact digest is approved", async () => {
  const { manager } = await managerFixture();
  await manager.scaffold("example_tool", "Example extension");
  const before = await manager.list();
  assert.equal(before[0]?.state, "disabled");
  const inspection = await manager.enable("example_tool", true);
  const enabled = await manager.list();
  assert.equal(enabled[0]?.state, "enabled");
  assert.equal(enabled[0]?.digest, inspection.digest);
});

test("syntax validation does not execute unapproved extension code", async () => {
  const { manager, root } = await managerFixture();
  const directory = await manager.scaffold("quiet_test", "Must not execute during validation");
  const canary = path.join(root, "executed.txt");
  await writeFile(path.join(directory, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canary)}, "executed");\nexport async function execute() { return { ok: true }; }\n`);
  await manager.validateSyntax("quiet_test");
  await assert.rejects(readFile(canary, "utf8"));
});

test("editing enabled code invalidates approval and prevents discovery", async () => {
  const { manager } = await managerFixture();
  const directory = await manager.scaffold("changing_tool", "Digest-bound extension");
  await manager.enable("changing_tool", true);
  assert.equal((await manager.discoverEnabled()).has("changing_tool"), true);

  await writeFile(path.join(directory, "index.js"), "export async function execute() { return { changed: true }; }\n");
  assert.equal((await manager.list())[0]?.state, "stale");
  assert.equal((await manager.discoverEnabled()).has("changing_tool"), false);
});

test("approval covers helper files and declared Alfred compatibility", async () => {
  const { manager } = await managerFixture();
  const directory = await manager.scaffold("helper_tool", "Extension with a helper");
  await writeFile(path.join(directory, "helper.js"), "export const value = 1;\n");
  await manager.enable("helper_tool", true);
  await writeFile(path.join(directory, "helper.js"), "export const value = 2;\n");
  assert.equal((await manager.list())[0]?.state, "stale");

  const incompatible = new ExtensionManager(path.dirname(directory), "1.0.0");
  assert.equal((await incompatible.list())[0]?.state, "invalid");
});

test("extension writes always revoke an earlier activation", async () => {
  const { manager } = await managerFixture();
  await manager.scaffold("written_tool", "Initial extension");
  await manager.enable("written_tool", true);
  await manager.write("written_tool", {
    schemaVersion: 1,
    name: "written_tool",
    version: "0.2.0",
    description: "Updated extension",
    entry: "index.js",
    inputHint: "{}",
    alfredVersion: "0.1.x",
    capabilities: ["workspace.read"]
  }, "export async function execute(input) { return { input }; }\n");
  assert.equal((await manager.list())[0]?.state, "disabled");
});
