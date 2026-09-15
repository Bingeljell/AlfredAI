import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "alfred-clean-install-"));
const packDir = path.join(temporaryRoot, "pack");
const installDir = path.join(temporaryRoot, "consumer");
const alfredHome = path.join(temporaryRoot, "private-home");
const npmCache = path.join(temporaryRoot, "npm-cache");
const packageName = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).name;

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? installDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache, ALFRED_HOME: alfredHome },
    timeout: options.timeout ?? 120_000
  });
  const allowed = options.allowedStatuses ?? [0];
  if (!allowed.includes(result.status)) {
    throw new Error([
      `Command failed (${result.status ?? "signal"}): ${file} ${args.join(" ")}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }
  return result;
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: repoRoot });
  const tarball = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not create a tarball");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(packDir, tarball)]);

  const packageRoot = path.join(installDir, "node_modules", packageName);
  const cli = path.join(packageRoot, "bin", "alfred.js");
  run(process.execPath, [cli, "--help"]);
  run(process.execPath, [cli, "setup", "--name", "Test User", "--provider", "codex", "--home", alfredHome]);
  run(process.execPath, [cli, "doctor", "--home", alfredHome, "--json"], { allowedStatuses: [0, 1] });
  run(process.execPath, [cli, "tools", "create", "smoke_tool", "--description", "Clean install test"]);
  run(process.execPath, [cli, "tools", "test", "smoke_tool"]);
  run(process.execPath, [cli, "tools", "enable", "smoke_tool", "--yes"]);

  for (const required of [
    path.join(alfredHome, "config", "config.env"),
    path.join(alfredHome, "identity", "SOUL.md"),
    path.join(alfredHome, "extensions", "smoke_tool", "enabled.json")
  ]) {
    if (!existsSync(required)) throw new Error(`Clean install did not create ${required}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, tarball, packageRoot, stateOutsidePackage: alfredHome }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
