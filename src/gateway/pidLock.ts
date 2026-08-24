import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface PidLockRecord {
  pid: number;
  startedAt: string;
  token: string;
  processTag: string;
}

export interface PidLockOptions {
  lockPath: string;
  pid?: number;
  processTag?: string;
  now?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  tokenFactory?: () => string;
}

export class PidLockAlreadyHeldError extends Error {
  readonly lockPath: string;
  readonly owner?: PidLockRecord;

  constructor(lockPath: string, owner?: PidLockRecord) {
    const ownerText = owner ? ` (pid ${owner.pid}${owner.processTag ? `, ${owner.processTag}` : ""})` : "";
    super(`Alfred server is already running${ownerText}; lock: ${lockPath}`);
    this.name = "PidLockAlreadyHeldError";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function parseRecord(raw: string): PidLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PidLockRecord>;
    const pid = value.pid;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof value.startedAt !== "string" ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.processTag !== "string"
    ) {
      return undefined;
    }
    return {
      pid,
      startedAt: value.startedAt,
      token: value.token,
      processTag: value.processTag
    };
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An ownership-safe, atomic PID lock for one Alfred server process.
 *
 * Lock creation uses wx. Stale locks are atomically renamed out of the way,
 * which prevents two simultaneous starters from both unlinking and replacing
 * the same dead lock.
 */
export class PidLock {
  private readonly options: Required<Pick<PidLockOptions, "pid" | "processTag" | "now" | "isProcessAlive" | "tokenFactory">>;
  private ownedRecord?: PidLockRecord;

  constructor(private readonly lockOptions: PidLockOptions) {
    this.options = {
      pid: lockOptions.pid ?? process.pid,
      processTag: lockOptions.processTag ?? process.title,
      now: lockOptions.now ?? (() => new Date().toISOString()),
      isProcessAlive: lockOptions.isProcessAlive ?? defaultIsProcessAlive,
      tokenFactory: lockOptions.tokenFactory ?? randomUUID
    };
  }

  get lockPath(): string {
    return this.lockOptions.lockPath;
  }

  async acquire(): Promise<void> {
    if (this.ownedRecord) {
      throw new Error(`PID lock is already owned by this process: ${this.lockPath}`);
    }

    await mkdir(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let handle: FileHandle | undefined;
      let created = false;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        created = true;
        const record: PidLockRecord = {
          pid: this.options.pid,
          startedAt: this.options.now(),
          token: this.options.tokenFactory(),
          processTag: this.options.processTag
        };
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.close();
        handle = undefined;
        this.ownedRecord = record;
        return;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) {
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }

      const owner = await this.readRecord();
      if (owner && this.options.isProcessAlive(owner.pid)) {
        throw new PidLockAlreadyHeldError(this.lockPath, owner);
      }

      const quarantined = await this.quarantineStaleLock();
      if (!quarantined) {
        // Another starter won the race to move the stale lock. Re-check the
        // path rather than deleting anything we do not own.
        continue;
      }
    }

    throw new Error(`Unable to acquire Alfred PID lock after repeated races: ${this.lockPath}`);
  }

  async release(): Promise<void> {
    const ownedRecord = this.ownedRecord;
    this.ownedRecord = undefined;
    if (!ownedRecord) {
      return;
    }

    let current: PidLockRecord | undefined;
    try {
      current = await this.readRecord();
    } catch {
      return;
    }
    if (!current || current.token !== ownedRecord.token) {
      return;
    }
    await unlink(this.lockPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    });
  }

  private async readRecord(): Promise<PidLockRecord | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let raw: string;
      try {
        raw = await readFile(this.lockPath, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      const record = parseRecord(raw);
      if (record) {
        return record;
      }
      if (attempt < 2) {
        await sleep(5);
      }
    }
    return undefined;
  }

  private async quarantineStaleLock(): Promise<boolean> {
    const quarantinePath = `${this.lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(this.lockPath, quarantinePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    }
    await unlink(quarantinePath).catch(() => undefined);
    return true;
  }
}
