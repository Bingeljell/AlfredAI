import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AlfredPaths {
  packageRoot: string;
  alfredHome: string;
  configDir: string;
  identityDir: string;
  workspaceDir: string;
  logsDir: string;
  runDir: string;
  backupsDir: string;
  extensionsDir: string;
  toolProjectRoot: string;
  usesLegacyWorkspace: boolean;
}

export interface ResolveAlfredPathsOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  packageRoot?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fromCwd(value: string, cwd: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export function installedPackageRoot(moduleUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../..");
}

/**
 * Resolve package-owned and user-owned paths without reading or writing disk.
 *
 * Until the migration command is shipped, omitting ALFRED_HOME preserves the
 * existing source-checkout workspace. Setting ALFRED_HOME opts into the new
 * private layout. Explicit workspace/project overrides always win.
 */
export function resolveAlfredPaths(options: ResolveAlfredPathsOptions = {}): AlfredPaths {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const packageRoot = path.resolve(options.packageRoot ?? installedPackageRoot());
  const homeOverride = nonEmpty(env.ALFRED_HOME);
  const packageMode = env.ALFRED_PACKAGE_MODE === "true";
  const workspaceOverride = nonEmpty(env.ALFRED_WORKSPACE_DIR);
  const projectOverride = nonEmpty(env.ALFRED_PROJECT_ROOT);
  const alfredHome = homeOverride ? fromCwd(homeOverride, cwd) : path.join(homeDir, ".alfred");

  return {
    packageRoot,
    alfredHome,
    configDir: path.join(alfredHome, "config"),
    identityDir: path.join(alfredHome, "identity"),
    workspaceDir: workspaceOverride
      ? fromCwd(workspaceOverride, cwd)
      : homeOverride || packageMode
        ? path.join(alfredHome, "workspace")
        : path.join(cwd, "workspace", "alfred"),
    logsDir: path.join(alfredHome, "logs"),
    runDir: path.join(alfredHome, "run"),
    backupsDir: path.join(alfredHome, "backups"),
    extensionsDir: path.join(alfredHome, "extensions"),
    toolProjectRoot: projectOverride ? fromCwd(projectOverride, cwd) : cwd,
    usesLegacyWorkspace: !packageMode && !homeOverride && !workspaceOverride
  };
}
