import { mkdir, readFile, open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 8));
        const retryRaw = await readFile(filePath, "utf8");
        return JSON.parse(retryRaw) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const mode = await stat(filePath).then((info) => info.mode & 0o777).catch(() => 0o600);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }); }
}

const fileTails = new Map<string, Promise<void>>();

/** One gateway owns the workspace; serialize mutations across store instances. */
export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileTails.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (fileTails.get(key) === current) fileTails.delete(key);
  }
}

export async function updateJsonFile<T, R>(filePath: string, fallback: T, update: (value: T) => R): Promise<R> {
  return withFileLock(filePath, async () => {
    const value: T = await readFile(filePath, "utf8").then((raw) => JSON.parse(raw) as T).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return fallback;
      throw error; // Never overwrite a corrupt or unreadable index with defaults.
    });
    const result = update(value);
    await writeJsonFile(filePath, value);
    return result;
  });
}
