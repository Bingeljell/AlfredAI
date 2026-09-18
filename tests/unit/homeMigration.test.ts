import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateAlfredHome, planHomeMigration } from "../../src/config/homeMigration.js";

async function fixture(): Promise<{ sourceRoot: string; targetHome: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alfred-home-migration-"));
  const sourceRoot = path.join(root, "checkout");
  const targetHome = path.join(root, "private", "alfred");
  await mkdir(path.join(sourceRoot, "workspace", "alfred", "sessions"), { recursive: true });
  await mkdir(path.join(sourceRoot, "logs"), { recursive: true });
  await writeFile(path.join(sourceRoot, ".env"), "SECRET=canary\n");
  await writeFile(path.join(sourceRoot, "SOUL.md"), "private identity\n");
  await writeFile(path.join(sourceRoot, "workspace", "alfred", "sessions", "one.json"), "{}\n");
  await writeFile(path.join(sourceRoot, "logs", "alfred.log"), "log\n");
  return { sourceRoot, targetHome };
}

test("home migration defaults to a non-mutating preview", async () => {
  const { sourceRoot, targetHome } = await fixture();
  const plan = await migrateAlfredHome({ sourceRoot, targetHome });

  assert.equal(plan.dryRun, true);
  assert.equal(plan.entries.every((entry) => entry.present), true);
  await assert.rejects(stat(targetHome));
  assert.equal(await readFile(path.join(sourceRoot, ".env"), "utf8"), "SECRET=canary\n");
});

test("home migration atomically copies private state without removing source data", async () => {
  const { sourceRoot, targetHome } = await fixture();
  const plan = await migrateAlfredHome({ sourceRoot, targetHome, apply: true });

  assert.equal(plan.dryRun, false);
  assert.equal(await readFile(path.join(targetHome, "config", "config.env"), "utf8"), "SECRET=canary\n");
  assert.equal(await readFile(path.join(targetHome, "identity", "SOUL.md"), "utf8"), "private identity\n");
  assert.equal(await readFile(path.join(targetHome, "workspace", "sessions", "one.json"), "utf8"), "{}\n");
  assert.equal(await readFile(path.join(targetHome, "logs", "alfred.log"), "utf8"), "log\n");
  assert.equal(await readFile(path.join(sourceRoot, ".env"), "utf8"), "SECRET=canary\n");
  assert.equal((await stat(targetHome)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(targetHome, "config", "config.env"))).mode & 0o777, 0o600);
  await assert.rejects(migrateAlfredHome({ sourceRoot, targetHome, apply: true }), /already exists/);
});

test("home migration rejects a target inside the public checkout", async () => {
  const { sourceRoot } = await fixture();
  await assert.rejects(
    planHomeMigration({ sourceRoot, targetHome: path.join(sourceRoot, ".alfred") }),
    /outside the source checkout/
  );
});
