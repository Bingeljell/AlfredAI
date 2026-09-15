import { cp, mkdir, rename, rm, stat, chmod } from "node:fs/promises";
import path from "node:path";

export interface HomeMigrationEntry {
  name: "config" | "identity" | "workspace" | "logs";
  source: string;
  destination: string;
  present: boolean;
  sensitive: boolean;
}

export interface HomeMigrationPlan {
  sourceRoot: string;
  targetHome: string;
  dryRun: boolean;
  entries: HomeMigrationEntry[];
}

export interface HomeMigrationOptions {
  sourceRoot: string;
  targetHome: string;
  sourceWorkspace?: string;
  apply?: boolean;
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function planHomeMigration(options: HomeMigrationOptions): Promise<HomeMigrationPlan> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const targetHome = path.resolve(options.targetHome);
  const sourceWorkspace = path.resolve(options.sourceWorkspace ?? path.join(sourceRoot, "workspace", "alfred"));

  if (sourceRoot === targetHome || isInside(sourceRoot, targetHome)) {
    throw new Error("ALFRED_HOME must be outside the source checkout so private state cannot enter the repository");
  }

  const definitions: Array<Omit<HomeMigrationEntry, "present">> = [
    {
      name: "config",
      source: path.join(sourceRoot, ".env"),
      destination: path.join(targetHome, "config", "config.env"),
      sensitive: true
    },
    {
      name: "identity",
      source: path.join(sourceRoot, "SOUL.md"),
      destination: path.join(targetHome, "identity", "SOUL.md"),
      sensitive: true
    },
    {
      name: "workspace",
      source: sourceWorkspace,
      destination: path.join(targetHome, "workspace"),
      sensitive: true
    },
    {
      name: "logs",
      source: path.join(sourceRoot, "logs"),
      destination: path.join(targetHome, "logs"),
      sensitive: true
    }
  ];

  const entries = await Promise.all(definitions.map(async (entry) => ({
    ...entry,
    present: await exists(entry.source)
  })));

  return { sourceRoot, targetHome, dryRun: options.apply !== true, entries };
}

export async function migrateAlfredHome(options: HomeMigrationOptions): Promise<HomeMigrationPlan> {
  const plan = await planHomeMigration(options);
  if (!options.apply) return plan;
  if (await exists(plan.targetHome)) {
    throw new Error(`Migration target already exists: ${plan.targetHome}`);
  }

  const staging = `${plan.targetHome}.staging-${process.pid}-${Date.now()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const entry of plan.entries) {
      if (!entry.present) continue;
      const relativeDestination = path.relative(plan.targetHome, entry.destination);
      const stagedDestination = path.join(staging, relativeDestination);
      await mkdir(path.dirname(stagedDestination), { recursive: true, mode: 0o700 });
      await cp(entry.source, stagedDestination, { recursive: true, force: false, errorOnExist: true });
      if (entry.name === "config" || entry.name === "identity") {
        await chmod(stagedDestination, 0o600);
      }
    }
    await mkdir(path.join(staging, "run"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(staging, "backups"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(staging, "extensions"), { recursive: true, mode: 0o700 });
    await rename(staging, plan.targetHome);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return { ...plan, dryRun: false };
}
