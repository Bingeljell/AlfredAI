import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAlfredPaths } from "../../src/config/paths.js";
import { MacServiceManager, renderLaunchAgent } from "../../src/config/service.js";

test("launch agent rendering escapes private paths and uses an argument array", () => {
  const plist = renderLaunchAgent({
    alfredHome: "/tmp/Alfred & Me",
    nodePath: "/opt/node",
    entryPath: "/tmp/alfred.js",
    stdoutPath: "/tmp/out.log",
    stderrPath: "/tmp/error.log"
  });
  assert.match(plist, /<string>\/tmp\/Alfred &amp; Me<\/string>/);
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>start<\/string>/);
  assert.doesNotMatch(plist, /nikhil/i);
});

test("service lifecycle uses modern user-domain launchctl commands and preserves home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "alfred-service-"));
  const paths = resolveAlfredPaths({
    env: { ALFRED_HOME: path.join(root, "home"), ALFRED_PACKAGE_MODE: "true" },
    cwd: root,
    homeDir: root,
    packageRoot: root
  });
  const commands: string[][] = [];
  let running = false;
  const manager = new MacServiceManager({
    paths,
    entryPath: "/usr/local/bin/alfred",
    platform: "darwin",
    uid: 501,
    launchAgentsDir: path.join(root, "LaunchAgents"),
    run: async (_file, args) => {
      commands.push(args);
      if (args[0] === "print" && !running) throw new Error("not loaded");
      if (args[0] === "bootstrap" || args[0] === "kickstart") running = true;
      if (args[0] === "bootout") running = false;
      return {};
    }
  });

  const installed = await manager.install();
  assert.equal(installed.running, true);
  assert.match(await readFile(installed.plistPath, "utf8"), /<string>\/usr\/local\/bin\/alfred<\/string>/);
  assert.equal(commands.some((command) => command[0] === "-lint"), true);
  assert.deepEqual(commands.at(-1), ["bootstrap", "gui/501", installed.plistPath]);

  assert.equal((await manager.status()).running, true);
  await manager.restart();
  assert.deepEqual(commands.at(-1), ["kickstart", "-k", "gui/501/com.alfred.agent"]);

  const removed = await manager.uninstall();
  assert.equal(removed.installed, false);
  assert.equal((await stat(paths.alfredHome)).isDirectory(), true);
  assert.equal(await readFile(installed.plistPath, "utf8").then(() => true).catch(() => false), false);
});

test("service management rejects unsupported platforms without calling launchctl", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "alfred-service-platform-"));
  let called = false;
  const manager = new MacServiceManager({
    paths: resolveAlfredPaths({ env: { ALFRED_HOME: path.join(root, "home") }, cwd: root, homeDir: root, packageRoot: root }),
    entryPath: "/tmp/alfred",
    platform: "linux",
    uid: 1000,
    launchAgentsDir: root,
    run: async () => { called = true; return {}; }
  });
  await assert.rejects(manager.status(), /macOS only/);
  assert.equal(called, false);
});
