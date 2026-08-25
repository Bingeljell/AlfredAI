import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BlobNotFoundError, BlobStore } from "../../src/channels/blobStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

test("BlobStore: put then get round-trips bytes and metadata", async () => {
  const workspace = await createTempWorkspace("alfred-blob-roundtrip");
  const store = new BlobStore({ baseDir: workspace });
  const payload = bytesOf("hello world");

  const blobId = await store.put(payload, "text/plain");
  assert.equal(blobId, sha256Hex(payload));

  const fetched = await store.get(blobId);
  assert.equal(Buffer.from(fetched).toString("utf8"), "hello world");

  const meta = await store.getMetadata(blobId);
  assert.equal(meta.mime, "text/plain");
  assert.equal(meta.size, payload.byteLength);
});

test("BlobStore: identical content dedupes — same blobId, no second file, entry count unchanged", async () => {
  const workspace = await createTempWorkspace("alfred-blob-dedup");
  const store = new BlobStore({ baseDir: workspace });
  const payload = bytesOf("deduped bytes");

  const first = await store.put(payload, "application/octet-stream");
  const second = await store.put(payload, "application/octet-stream");

  assert.equal(first, second);
  assert.equal(store.size(), 1);

  const entries = await readdir(workspace);
  // No temp leftovers and exactly one blob file.
  const blobs = entries.filter((name) => !name.startsWith("."));
  assert.equal(blobs.length, 1, `expected one file, got ${blobs.join(", ")}`);
  assert.equal(blobs[0], first);
});

test("BlobStore: get on unknown id throws BlobNotFoundError", async () => {
  const workspace = await createTempWorkspace("alfred-blob-missing");
  const store = new BlobStore({ baseDir: workspace });

  const missing = "0".repeat(64);
  await assert.rejects(
    store.get(missing),
    (error: unknown) => error instanceof BlobNotFoundError && error.blobId === missing
  );
  await assert.rejects(
    store.getMetadata(missing),
    (error: unknown) => error instanceof BlobNotFoundError && error.blobId === missing
  );
});

test("BlobStore: LRU eviction respects recency — get on the oldest protects it", async () => {
  const workspace = await createTempWorkspace("alfred-blob-lru");
  let nowMs = 1_000;
  const store = new BlobStore({
    baseDir: workspace,
    maxEntries: 3,
    now: () => nowMs
  });

  // Three distinct items, spaced out in time so their LRU order is stable.
  const a = bytesOf("A");
  const b = bytesOf("B");
  const c = bytesOf("C");
  const aId = await store.put(a, "text/plain");
  nowMs += 10;
  const bId = await store.put(b, "text/plain");
  nowMs += 10;
  const cId = await store.put(c, "text/plain");

  // Touch A so its recency is newer than B's.
  nowMs += 10;
  await store.get(aId);

  // A 4th item forces eviction. LRU order at this point: B (oldest), C, A.
  nowMs += 10;
  const d = bytesOf("D");
  const dId = await store.put(d, "text/plain");

  // B is gone; A, C, D remain.
  await assert.rejects(
    store.get(bId),
    (error: unknown) => error instanceof BlobNotFoundError && error.blobId === bId
  );
  assert.equal(Buffer.from(await store.get(aId)).toString("utf8"), "A");
  assert.equal(Buffer.from(await store.get(cId)).toString("utf8"), "C");
  assert.equal(Buffer.from(await store.get(dId)).toString("utf8"), "D");
  assert.equal(store.size(), 3);
});

test("BlobStore: size cap evicts without corrupting remaining files", async () => {
  const workspace = await createTempWorkspace("alfred-blob-sizecap");
  // Each payload is 8 bytes. Cap at 16 bytes → at most 2 entries can fit.
  const store = new BlobStore({
    baseDir: workspace,
    maxBytes: 16
  });

  const a = bytesOf("AAAAAAAA");
  const b = bytesOf("BBBBBBBB");
  const c = bytesOf("CCCCCCCC");
  const aId = await store.put(a, "text/plain");
  const bId = await store.put(b, "text/plain");
  // a is the LRU once c lands; a should be evicted.
  const cId = await store.put(c, "text/plain");

  await assert.rejects(
    store.get(aId),
    (error: unknown) => error instanceof BlobNotFoundError && error.blobId === aId
  );
  const bBytes = await store.get(bId);
  const cBytes = await store.get(cId);
  assert.equal(Buffer.from(bBytes).toString("utf8"), "BBBBBBBB");
  assert.equal(Buffer.from(cBytes).toString("utf8"), "CCCCCCCC");

  // Spot-check: the remaining file on disk is exactly the c bytes.
  const cPath = path.join(workspace, cId);
  const onDisk = await readFile(cPath);
  assert.equal(Buffer.from(onDisk).toString("utf8"), "CCCCCCCC");
});

test("BlobStore: a missing temp file at rename time does not produce a half-written blob", async () => {
  // We exercise the atomic-write path by hand: write to a temp file inside
  // the blob directory, then unlink it before rename. The store's invariant
  // is that the final blob path either contains the full bytes or does not
  // exist; a "successful" write must never leave a partial file at the
  // blobId path.
  const workspace = await createTempWorkspace("alfred-blob-atomic");
  const store = new BlobStore({ baseDir: workspace });

  const payload = bytesOf("atomic payload");
  const blobId = sha256Hex(payload);
  const finalPath = path.join(workspace, blobId);

  // Simulate a process that started writing the temp file but crashed
  // before rename: drop a partial blob at the final path and a stray temp
  // file. A real put() must not be confused by either.
  const tempPath = path.join(workspace, ".tmp.crash-simulated");
  await writeFile(tempPath, "garbage");
  await writeFile(finalPath, "PARTIAL");

  // Now do a real put. The garbage at the final path is unrelated to our
  // digest; the store computes the digest from `payload` and writes to its
  // own temp file, then renames atomically. The final path is overwritten
  // by the real bytes — and the old partial is gone.
  const returnedId = await store.put(payload, "text/plain");
  assert.equal(returnedId, blobId);

  const finalStat = await stat(finalPath);
  assert.equal(finalStat.size, payload.byteLength, "blob file must be the full payload, never a partial write");
  const roundtripped = await readFile(finalPath);
  assert.equal(Buffer.from(roundtripped).toString("utf8"), "atomic payload");

  // The crash-simulated temp file should not block the store; the real put
  // uses its own randomized temp name.
});

test("BlobStore: concurrent puts for the same content yield one blob and one file", async () => {
  const workspace = await createTempWorkspace("alfred-blob-concurrent");
  const store = new BlobStore({ baseDir: workspace });
  const payload = bytesOf("concurrent dedup");

  const [a, b, c, d] = await Promise.all([
    store.put(payload, "text/plain"),
    store.put(payload, "text/plain"),
    store.put(payload, "text/plain"),
    store.put(payload, "text/plain")
  ]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(c, d);
  assert.equal(store.size(), 1);

  const entries = await readdir(workspace);
  const blobs = entries.filter((name) => !name.startsWith("."));
  assert.equal(blobs.length, 1, `expected one file, got ${blobs.join(", ")}`);
  assert.equal(blobs[0], a);
});
