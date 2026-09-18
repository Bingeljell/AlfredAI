import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveAlfredPaths } from "../../src/config/paths.js";

const cwd = path.resolve("/tmp/alfred-project");
const homeDir = path.resolve("/tmp/alfred-user");
const packageRoot = path.resolve("/opt/alfred-package");

test("path resolution preserves the source-checkout workspace by default", () => {
  const paths = resolveAlfredPaths({ env: {}, cwd, homeDir, packageRoot });

  assert.equal(paths.packageRoot, packageRoot);
  assert.equal(paths.alfredHome, path.join(homeDir, ".alfred"));
  assert.equal(paths.workspaceDir, path.join(cwd, "workspace", "alfred"));
  assert.equal(paths.toolProjectRoot, cwd);
  assert.equal(paths.usesLegacyWorkspace, true);
});

test("ALFRED_HOME opts into isolated private state", () => {
  const paths = resolveAlfredPaths({
    env: { ALFRED_HOME: "./private-instance" },
    cwd,
    homeDir,
    packageRoot
  });

  const alfredHome = path.join(cwd, "private-instance");
  assert.equal(paths.alfredHome, alfredHome);
  assert.equal(paths.configDir, path.join(alfredHome, "config"));
  assert.equal(paths.identityDir, path.join(alfredHome, "identity"));
  assert.equal(paths.workspaceDir, path.join(alfredHome, "workspace"));
  assert.equal(paths.logsDir, path.join(alfredHome, "logs"));
  assert.equal(paths.runDir, path.join(alfredHome, "run"));
  assert.equal(paths.backupsDir, path.join(alfredHome, "backups"));
  assert.equal(paths.extensionsDir, path.join(alfredHome, "extensions"));
  assert.equal(paths.usesLegacyWorkspace, false);
});

test("explicit workspace and project roots take precedence", () => {
  const paths = resolveAlfredPaths({
    env: {
      ALFRED_HOME: "/srv/alfred",
      ALFRED_WORKSPACE_DIR: "./shared-workspace",
      ALFRED_PROJECT_ROOT: "/srv/projects/allowed"
    },
    cwd,
    homeDir,
    packageRoot
  });

  assert.equal(paths.workspaceDir, path.join(cwd, "shared-workspace"));
  assert.equal(paths.toolProjectRoot, "/srv/projects/allowed");
  assert.equal(paths.usesLegacyWorkspace, false);
});

test("two ALFRED_HOME values do not share mutable paths", () => {
  const first = resolveAlfredPaths({ env: { ALFRED_HOME: "/tmp/alfred-one" }, cwd, homeDir, packageRoot });
  const second = resolveAlfredPaths({ env: { ALFRED_HOME: "/tmp/alfred-two" }, cwd, homeDir, packageRoot });

  for (const key of ["configDir", "identityDir", "workspaceDir", "logsDir", "runDir", "backupsDir", "extensionsDir"] as const) {
    assert.notEqual(first[key], second[key], key);
  }
});
