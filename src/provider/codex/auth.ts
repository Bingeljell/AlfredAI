import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, lstat, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { refreshCodexAccessToken, type CodexOAuthToken } from "./oauth.js";

export const CODEX_LOGIN_INVALID = "Codex login is invalid. Run pnpm codex:login.";
export const CODEX_LOGIN_EXPIRED = "Codex login expired. Run pnpm codex:login.";

export interface CodexCredentialFileV1 {
  version: 1;
  provider: "codex";
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  accountId: string;
}

export const CodexCredentialSchema = z.object({
  version: z.literal(1),
  provider: z.literal("codex"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAtMs: z.number().finite(),
  accountId: z.string().min(1)
});

export interface CodexAuthOptions {
  authFilePath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  nowMs?: () => number;
  forceRefresh?: boolean;
}

function repositoryRoot(): string {
  return path.resolve(process.cwd());
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveCodexAuthPath(explicitPath?: string): string {
  const configured = explicitPath ?? process.env.ALFRED_CODEX_AUTH_FILE;
  const candidate = configured?.trim() || path.join(os.homedir(), ".alfred", "codex-auth.json");
  const absolute = path.resolve(candidate);
  if (isInside(repositoryRoot(), absolute)) {
    throw new Error("Codex auth file must be outside the Alfred repository.");
  }
  return absolute;
}

async function assertSafeCodexAuthPath(authPath: string): Promise<void> {
  const root = await realpath(repositoryRoot()).catch(() => repositoryRoot());
  let current = authPath;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        if (current === authPath) throw new Error("Codex auth file must not be a symlink.");
        const resolved = await realpath(current).catch(() => { throw new Error("Codex auth path must not contain dangling symlinked components."); });
        if (isInside(root, resolved)) throw new Error("Codex auth file must be outside the Alfred repository.");
      } else {
        const resolved = await realpath(current);
        if (isInside(root, resolved)) throw new Error("Codex auth file must be outside the Alfred repository.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function readCodexCredentials(explicitPath?: string): Promise<CodexCredentialFileV1> {
  const authPath = resolveCodexAuthPath(explicitPath);
  await assertSafeCodexAuthPath(authPath);
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    throw new Error(CODEX_LOGIN_INVALID);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(CODEX_LOGIN_INVALID);
  }
  const parsed = CodexCredentialSchema.safeParse(value);
  if (!parsed.success) throw new Error(CODEX_LOGIN_INVALID);
  return parsed.data;
}

async function ensureParentDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

export async function writeCodexCredentials(credentials: CodexCredentialFileV1, explicitPath?: string): Promise<void> {
  const parsed = CodexCredentialSchema.safeParse(credentials);
  if (!parsed.success) throw new Error(CODEX_LOGIN_INVALID);
  const authPath = resolveCodexAuthPath(explicitPath);
  await assertSafeCodexAuthPath(authPath);
  const directory = path.dirname(authPath);
  await ensureParentDirectory(directory);
  const temporaryPath = path.join(directory, `.codex-auth-${path.basename(authPath)}-${process.pid}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, authPath);
    await chmod(authPath, 0o600).catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function lockPath(authPath: string): string {
  return `${authPath}.lock`;
}

function temporaryPrefix(authPath: string): string {
  return `.codex-auth-${path.basename(authPath)}-`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Codex login cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Codex login cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireLock(authPath: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const filePath = lockPath(authPath);
  await assertSafeCodexAuthPath(authPath);
  await ensureParentDirectory(path.dirname(authPath));
  for (;;) {
    if (signal?.aborted) throw new Error("Codex login cancelled.");
    try {
      const handle = await open(filePath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => { await unlink(filePath).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(filePath);
        if (Date.now() - info.mtimeMs > 30_000) await unlink(filePath).catch(() => undefined);
      } catch {
        // The lock disappeared between the exclusive create and stat.
      }
      await sleep(50, signal);
    }
  }
}

async function refreshCredentials(authPath: string, options: CodexAuthOptions): Promise<CodexCredentialFileV1> {
  const release = await acquireLock(authPath, options.signal);
  try {
    const latest = await readCodexCredentials(authPath);
    const now = options.nowMs?.() ?? Date.now();
    if (latest.expiresAtMs > now + 5 * 60 * 1000 && options.forceRefresh !== true) return latest;

    let refreshed: CodexOAuthToken;
    try {
      refreshed = await refreshCodexAccessToken(latest.refreshToken, {
        fetchImpl: options.fetchImpl,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new Error(CODEX_LOGIN_EXPIRED);
    }
    const next: CodexCredentialFileV1 = {
      version: 1,
      provider: "codex",
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAtMs: refreshed.expiresAtMs,
      accountId: refreshed.accountId
    };
    await writeCodexCredentials(next, authPath);
    return next;
  } finally {
    await release();
  }
}

const refreshes = new Map<string, Promise<CodexCredentialFileV1>>();

export async function getCodexCredentials(options: CodexAuthOptions = {}): Promise<CodexCredentialFileV1> {
  const authPath = resolveCodexAuthPath(options.authFilePath);
  const current = await readCodexCredentials(authPath);
  const now = options.nowMs?.() ?? Date.now();
  const shouldRefresh = options.forceRefresh === true || current.expiresAtMs <= now + 5 * 60 * 1000;
  if (!shouldRefresh) return current;

  const existing = refreshes.get(authPath);
  if (existing) return existing;
  const operation = refreshCredentials(authPath, options);
  refreshes.set(authPath, operation);
  try {
    return await operation;
  } finally {
    if (refreshes.get(authPath) === operation) refreshes.delete(authPath);
  }
}

export async function removeCodexCredentials(explicitPath?: string): Promise<void> {
  const authPath = resolveCodexAuthPath(explicitPath);
  await assertSafeCodexAuthPath(authPath);
  await unlink(authPath).catch(() => undefined);
  await unlink(lockPath(authPath)).catch(() => undefined);
  const directory = path.dirname(authPath);
  const prefix = temporaryPrefix(authPath);
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if (entry.startsWith(prefix) && entry.endsWith(".tmp")) await rm(path.join(directory, entry), { force: true }).catch(() => undefined);
  }
}

export function codexCredentialsFromOAuthToken(token: CodexOAuthToken): CodexCredentialFileV1 {
  return {
    version: 1,
    provider: "codex",
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAtMs: token.expiresAtMs,
    accountId: token.accountId
  };
}
