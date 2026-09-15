import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAlfredPaths } from "../../src/config/paths.js";
import { initializeAlfredHome } from "../../src/config/setup.js";
import { diagnoseAlfred } from "../../src/config/doctor.js";

async function setupFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alfred-setup-"));
  const packageRoot = path.join(root, "package");
  const home = path.join(root, "home");
  const paths = resolveAlfredPaths({ env: { ALFRED_HOME: home }, packageRoot, cwd: root, homeDir: root });
  await mkdir(path.join(packageRoot, "templates"), { recursive: true });
  await writeFile(path.join(packageRoot, "templates", "SOUL.md"), "Alfred works with [your name].\n");
  await writeFile(path.join(packageRoot, "templates", "INSTRUCTIONS.md"), "# Instructions\n");
  return { paths };
}

test("setup creates private templates once and preserves user edits on rerun", async () => {
  const { paths } = await setupFixture();
  const first = await initializeAlfredHome({ paths, name: "Ada", provider: "openrouter", model: "test/model" });
  assert.equal(first.created.length, 3);
  assert.match(await readFile(path.join(paths.identityDir, "SOUL.md"), "utf8"), /Ada/);
  assert.match(await readFile(path.join(paths.configDir, "config.env"), "utf8"), /ALFRED_LLM_PROVIDER=openrouter/);
  assert.equal((await stat(path.join(paths.configDir, "config.env"))).mode & 0o777, 0o600);

  await writeFile(path.join(paths.identityDir, "SOUL.md"), "custom identity\n");
  const second = await initializeAlfredHome({ paths, name: "Different", provider: "gemini" });
  assert.equal(second.created.length, 0);
  assert.equal(second.preserved.length, 3);
  assert.equal(await readFile(path.join(paths.identityDir, "SOUL.md"), "utf8"), "custom identity\n");
});

test("doctor reports configured credentials without exposing their value", async () => {
  const { paths } = await setupFixture();
  await initializeAlfredHome({ paths, name: "Ada", provider: "openrouter" });
  const secret = "private-test-secret";
  const report = await diagnoseAlfred(paths, { OPENROUTER_API_KEY: secret });
  const serialized = JSON.stringify(report);
  assert.equal(report.ok, true);
  assert.equal(serialized.includes(secret), false);
  assert.equal(report.checks.some((check) => check.id === "provider" && check.status === "pass"), true);
});

test("doctor fails clearly when the selected provider credential is absent", async () => {
  const { paths } = await setupFixture();
  await initializeAlfredHome({ paths, name: "Ada", provider: "openrouter" });
  const report = await diagnoseAlfred(paths, {});
  assert.equal(report.ok, false);
  assert.equal(report.checks.some((check) => check.message.includes("OPENROUTER_API_KEY is missing")), true);
});
