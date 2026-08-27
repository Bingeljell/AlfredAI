import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;

export interface BlobStoreOptions {
  /** Absolute directory containing content-addressed blob files. */
  baseDir: string;
  /** On-disk byte cap. Zero disables the byte cap. */
  maxBytes?: number;
  /** Stored-blob count cap. Zero disables the entry cap. */
  maxEntries?: number;
  /** Injectable wall clock for deterministic LRU tests. */
  now?: () => number;
}

export interface BlobMetadata {
  mime: string;
  size: number;
}

interface PersistedBlobMetadata extends BlobMetadata {
  lastAccessAtMs: number;
}

export class BlobNotFoundError extends Error {
  readonly blobId: string;

  constructor(blobId: string) {
    super(`blob not found: ${blobId}`);
    this.name = "BlobNotFoundError";
    this.blobId = blobId;
  }
}

export class BlobTooLargeError extends Error {
  readonly size: number;
  readonly maxBytes: number;

  constructor(size: number, maxBytes: number) {
    super(`blob size ${size} exceeds store limit ${maxBytes}`);
    this.name = "BlobTooLargeError";
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/**
 * Content-addressed blob storage with durable metadata and serialized LRU
 * eviction. Blob bytes live at `{baseDir}/{sha256}`; hidden sidecars preserve
 * MIME and recency across process restarts.
 */
export class BlobStore {
  private readonly baseDir: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly index = new Map<string, PersistedBlobMetadata>();
  private operationTail: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: BlobStoreOptions) {
    if (!options || typeof options.baseDir !== "string" || options.baseDir.trim().length === 0) {
      throw new Error("BlobStore: baseDir is required");
    }
    if (!path.isAbsolute(options.baseDir)) {
      throw new Error("BlobStore: baseDir must be absolute");
    }

    this.baseDir = options.baseDir;
    this.maxBytes = validateCap("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxEntries = validateCap("maxEntries", options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("BlobStore.put: bytes must be a Uint8Array");
    }
    if (typeof mime !== "string" || mime.trim().length === 0) {
      throw new TypeError("BlobStore.put: mime must be a non-empty string");
    }
    if (this.maxBytes > 0 && bytes.byteLength > this.maxBytes) {
      throw new BlobTooLargeError(bytes.byteLength, this.maxBytes);
    }

    const blobId = sha256Hex(bytes);
    return this.withLock(async () => {
      await this.initializeLocked();

      const existing = this.index.get(blobId);
      if (existing && await this.fileMatchesDigest(blobId)) {
        existing.lastAccessAtMs = this.now();
        if (existing.mime === "application/octet-stream") existing.mime = mime;
        await this.writeMetadataLocked(blobId, existing);
        return blobId;
      }

      this.index.delete(blobId);
      await this.writeBlobLocked(blobId, bytes);
      const metadata: PersistedBlobMetadata = {
        mime,
        size: bytes.byteLength,
        lastAccessAtMs: this.now(),
      };
      this.index.set(blobId, metadata);
      await this.writeMetadataLocked(blobId, metadata);
      await this.evictUntilUnderCapLocked(blobId);
      return blobId;
    });
  }

  async get(blobId: string): Promise<Uint8Array> {
    validateBlobId(blobId);
    return this.withLock(async () => {
      await this.initializeLocked();
      const metadata = this.index.get(blobId);
      if (!metadata) throw new BlobNotFoundError(blobId);

      try {
        const bytes = await readFile(this.blobPath(blobId));
        metadata.lastAccessAtMs = this.now();
        await this.writeMetadataLocked(blobId, metadata);
        return bytes;
      } catch (error) {
        if (isNotFoundError(error)) {
          this.index.delete(blobId);
          await unlink(this.metadataPath(blobId)).catch(() => undefined);
          throw new BlobNotFoundError(blobId);
        }
        throw error;
      }
    });
  }

  async getMetadata(blobId: string): Promise<BlobMetadata> {
    validateBlobId(blobId);
    return this.withLock(async () => {
      await this.initializeLocked();
      const metadata = this.index.get(blobId);
      if (!metadata) throw new BlobNotFoundError(blobId);

      try {
        await stat(this.blobPath(blobId));
      } catch (error) {
        if (isNotFoundError(error)) {
          this.index.delete(blobId);
          await unlink(this.metadataPath(blobId)).catch(() => undefined);
          throw new BlobNotFoundError(blobId);
        }
        throw error;
      }

      metadata.lastAccessAtMs = this.now();
      await this.writeMetadataLocked(blobId, metadata);
      return { mime: metadata.mime, size: metadata.size };
    });
  }

  /** Number of initialized, currently indexed blobs. */
  size(): number {
    return this.index.size;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async initializeLocked(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !SHA256_HEX.test(entry.name)) continue;
      const blobId = entry.name;
      const blobStat = await stat(this.blobPath(blobId));
      const persisted = await this.readMetadataLocked(blobId);
      this.index.set(blobId, {
        mime: persisted?.mime ?? "application/octet-stream",
        size: blobStat.size,
        lastAccessAtMs: persisted?.lastAccessAtMs ?? blobStat.mtimeMs,
      });
    }

    await this.evictUntilUnderCapLocked();
    this.initialized = true;
  }

  private async readMetadataLocked(blobId: string): Promise<PersistedBlobMetadata | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath(blobId), "utf8")) as Partial<PersistedBlobMetadata>;
      if (
        typeof parsed.mime === "string" && parsed.mime.length > 0 &&
        typeof parsed.size === "number" && Number.isSafeInteger(parsed.size) && parsed.size >= 0 &&
        typeof parsed.lastAccessAtMs === "number" && Number.isFinite(parsed.lastAccessAtMs)
      ) {
        return parsed as PersistedBlobMetadata;
      }
    } catch {
      // Missing or malformed sidecars are reconstructed from the blob.
    }
    return undefined;
  }

  private async fileMatchesDigest(blobId: string): Promise<boolean> {
    try {
      return sha256Hex(await readFile(this.blobPath(blobId))) === blobId;
    } catch {
      return false;
    }
  }

  private async writeBlobLocked(blobId: string, bytes: Uint8Array): Promise<void> {
    await writeAtomicFile(this.blobPath(blobId), bytes);
  }

  private async writeMetadataLocked(blobId: string, metadata: PersistedBlobMetadata): Promise<void> {
    const encoded = new TextEncoder().encode(`${JSON.stringify(metadata)}\n`);
    await writeAtomicFile(this.metadataPath(blobId), encoded);
  }

  private async evictUntilUnderCapLocked(protectedBlobId?: string): Promise<void> {
    while (this.isOverCap()) {
      const victim = pickLeastRecentlyUsed(this.index, protectedBlobId);
      if (!victim) {
        throw new Error("BlobStore: capacity cannot be satisfied without evicting the active blob");
      }
      await unlink(this.blobPath(victim)).catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
      await unlink(this.metadataPath(victim)).catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
      this.index.delete(victim);
    }
  }

  private isOverCap(): boolean {
    if (this.maxEntries > 0 && this.index.size > this.maxEntries) return true;
    if (this.maxBytes <= 0) return false;
    let totalBytes = 0;
    for (const metadata of this.index.values()) totalBytes += metadata.size;
    return totalBytes > this.maxBytes;
  }

  private blobPath(blobId: string): string {
    return path.join(this.baseDir, blobId);
  }

  private metadataPath(blobId: string): string {
    return path.join(this.baseDir, `.meta.${blobId}.json`);
  }
}

async function writeAtomicFile(finalPath: string, bytes: Uint8Array): Promise<void> {
  const tempPath = path.join(path.dirname(finalPath), `.tmp.${randomBytes(12).toString("hex")}`);
  try {
    const handle = await open(tempPath, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function validateCap(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`BlobStore: ${name} must be a non-negative safe integer`);
  }
  return value;
}

function validateBlobId(blobId: string): void {
  if (!SHA256_HEX.test(blobId)) {
    throw new TypeError("BlobStore: blobId must be a lowercase sha256 digest");
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pickLeastRecentlyUsed(
  index: Map<string, PersistedBlobMetadata>,
  protectedBlobId?: string,
): string | undefined {
  let victim: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [blobId, metadata] of index) {
    if (blobId === protectedBlobId) continue;
    if (metadata.lastAccessAtMs < oldestAt) {
      oldestAt = metadata.lastAccessAtMs;
      victim = blobId;
    }
  }
  return victim;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
