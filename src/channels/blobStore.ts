import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Options for {@link BlobStore}.
 *
 * The store enforces at least one of a byte cap or an entry-count cap. Both
 * caps are evaluated on every successful write; the store evicts least-
 * recently-used entries until it is under both limits. Touching a blob via
 * {@link BlobStore.get} or {@link BlobStore.getMetadata} refreshes its
 * recency so active attachments are not evicted under pressure.
 */
export interface BlobStoreOptions {
  /** Absolute path to the directory that holds the content-addressed blobs. */
  baseDir: string;
  /**
   * Soft cap on total on-disk bytes. `0` or `undefined` disables this cap.
   * @default 2 * 1024 * 1024 * 1024 (2 GiB)
   */
  maxBytes?: number;
  /**
   * Soft cap on number of stored blobs. `0` or `undefined` disables this cap.
   * @default 10_000
   */
  maxEntries?: number;
  /**
   * Source of "now" for LRU bookkeeping. Override in tests.
   * @default Date.now
   */
  now?: () => number;
}

export interface BlobMetadata {
  mime: string;
  size: number;
}

interface BlobIndexEntry {
  size: number;
  mime: string;
  lastAccessAtMs: number;
}

/**
 * Thrown when {@link BlobStore.get} or {@link BlobStore.getMetadata} is
 * called with a digest that does not exist on disk.
 */
export class BlobNotFoundError extends Error {
  readonly blobId: string;
  constructor(blobId: string) {
    super(`blob not found: ${blobId}`);
    this.name = "BlobNotFoundError";
    this.blobId = blobId;
  }
}

/**
 * Content-addressed blob store with LRU eviction and size caps.
 *
 * Each blob lives at `{baseDir}/{sha256_hex}` (flat, no subdirs, no extension).
 * Writes are atomic: bytes are streamed to a temporary file and then renamed
 * into place, so a crash mid-write never produces a half-written file at the
 * final path. {@link BlobStore.put} is idempotent on identical content — the
 * sha256 is computed first, the index is consulted, and only the first writer
 * for a given digest actually writes bytes. Concurrent puts for the same
 * content are singleflighted so they observe the same result.
 */
export class BlobStore {
  private readonly baseDir: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly index = new Map<string, BlobIndexEntry>();
  /** In-flight puts keyed by digest, used to singleflight concurrent writers. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: BlobStoreOptions) {
    if (!options || typeof options.baseDir !== "string" || options.baseDir.length === 0) {
      throw new Error("BlobStore: baseDir is required");
    }
    this.baseDir = options.baseDir;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Write bytes to the store. Idempotent on identical content: the sha256 is
   * computed first; if a blob with that digest already exists, no new file is
   * written and the existing id is returned with its LRU entry refreshed.
   *
   * After a successful write, evicts least-recently-used entries until both
   * the byte and entry-count caps are satisfied.
   */
  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("BlobStore.put: bytes must be a Uint8Array");
    }
    if (typeof mime !== "string" || mime.length === 0) {
      throw new TypeError("BlobStore.put: mime must be a non-empty string");
    }

    const digest = sha256Hex(bytes);

    // Fast path: already on disk — refresh LRU and return.
    const existing = this.index.get(digest);
    if (existing) {
      existing.lastAccessAtMs = this.now();
      return digest;
    }

    // Singleflight: if another put for the same digest is in flight, wait.
    const pending = this.inFlight.get(digest);
    if (pending) {
      return pending;
    }

    const work = this.writeBlob(digest, bytes, mime)
      .then((id) => {
        this.evictUntilUnderCap();
        return id;
      })
      .finally(() => {
        if (this.inFlight.get(digest) === work) {
          this.inFlight.delete(digest);
        }
      });
    this.inFlight.set(digest, work);
    return work;
  }

  /**
   * Read raw bytes for a blob. Refreshes the LRU entry. Throws
   * {@link BlobNotFoundError} if the digest is unknown — including the
   * race where the file was evicted between the index check and the read.
   */
  async get(blobId: string): Promise<Uint8Array> {
    const entry = await this.touchOrThrow(blobId);
    entry.lastAccessAtMs = this.now();
    try {
      return await readFile(this.pathFor(blobId));
    } catch (error) {
      if (isNotFoundError(error)) {
        // The blob was evicted or otherwise vanished. Drop the stale index
        // entry and surface a uniform "not found" to the caller.
        this.index.delete(blobId);
        throw new BlobNotFoundError(blobId);
      }
      throw error;
    }
  }

  /**
   * Read metadata for a blob. Refreshes the LRU entry. Throws
   * {@link BlobNotFoundError} if the digest is unknown.
   */
  async getMetadata(blobId: string): Promise<BlobMetadata> {
    const entry = await this.touchOrThrow(blobId);
    entry.lastAccessAtMs = this.now();
    return { mime: entry.mime, size: entry.size };
  }

  /**
   * Return the index entry for `blobId`, hydrating it from disk if the
   * process restarted and the in-memory index is cold. Throws
   * {@link BlobNotFoundError} if neither the index nor the filesystem has
   * the blob.
   */
  private async touchOrThrow(blobId: string): Promise<BlobIndexEntry> {
    const known = this.index.get(blobId);
    if (known) {
      return known;
    }
    let fileStat;
    try {
      fileStat = await stat(this.pathFor(blobId));
    } catch {
      throw new BlobNotFoundError(blobId);
    }
    const hydrated: BlobIndexEntry = {
      size: fileStat.size,
      mime: "application/octet-stream",
      lastAccessAtMs: this.now()
    };
    this.index.set(blobId, hydrated);
    return hydrated;
  }

  /**
   * Number of blobs currently tracked in the in-memory index. Useful for
   * tests and for the periodic sweep the architecture doc mentions.
   */
  size(): number {
    return this.index.size;
  }

  private async writeBlob(digest: string, bytes: Uint8Array, mime: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const finalPath = this.pathFor(digest);
    const tempPath = path.join(this.baseDir, `.tmp.${randomBytes(8).toString("hex")}`);

    // Use a handle so we can write atomically and fsync before rename.
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    // rename is atomic on POSIX when source and destination are on the same
    // filesystem, which they are by construction.
    try {
      await rename(tempPath, finalPath);
    } catch (error) {
      // Best-effort cleanup of the temp file if rename failed.
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }

    this.index.set(digest, {
      size: bytes.byteLength,
      mime,
      lastAccessAtMs: this.now()
    });
    return digest;
  }

  private pathFor(blobId: string): string {
    return path.join(this.baseDir, blobId);
  }

  private evictUntilUnderCap(): void {
    const byteCap = this.maxBytes;
    const entryCap = this.maxEntries;
    if (byteCap <= 0 && entryCap <= 0) {
      return;
    }

    // Sort once; re-derive on every loop so an evicted entry that turns out
    // to be below cap is correctly skipped.
    while (this.index.size > 0) {
      const totalBytes = sumBytes(this.index);
      const underBytes = byteCap <= 0 || totalBytes <= byteCap;
      const underEntries = entryCap <= 0 || this.index.size <= entryCap;
      if (underBytes && underEntries) {
        return;
      }

      const lru = pickLeastRecentlyUsed(this.index);
      if (!lru) {
        return;
      }
      this.index.delete(lru.id);
      // Best-effort unlink: ignore ENOENT (already gone) and surface the
      // rest, since a leaked file would defeat the size cap.
      void unlink(this.pathFor(lru.id)).catch((error: NodeJS.ErrnoException) => {
        if (error && error.code !== "ENOENT") {
          // Re-throw asynchronously so it is observable but does not
          // interrupt the eviction loop mid-write.
          queueMicrotask(() => {
            throw error;
          });
        }
      });
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sumBytes(index: Map<string, BlobIndexEntry>): number {
  let total = 0;
  for (const entry of index.values()) {
    total += entry.size;
  }
  return total;
}

function pickLeastRecentlyUsed(
  index: Map<string, BlobIndexEntry>
): { id: string; entry: BlobIndexEntry } | undefined {
  let oldestId: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [id, entry] of index) {
    if (entry.lastAccessAtMs < oldestAt) {
      oldestAt = entry.lastAccessAtMs;
      oldestId = id;
    }
  }
  if (oldestId === undefined) {
    return undefined;
  }
  return { id: oldestId, entry: index.get(oldestId)! };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
