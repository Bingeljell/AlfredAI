import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PidLock, PidLockAlreadyHeldError } from "../../src/gateway/pidLock.js";
import { ALFRED_SERVER_PROCESS_TAG, managedProcessTag } from "../../src/gateway/processIdentity.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("PID lock atomically rejects a live second owner and releases its own record", async () => {
  const workspace = await createTempWorkspace("alfred-pid-lock-live");
  const lockPath = path.join(workspace, "alfred.pid");
  const first = new PidLock({
    lockPath,
    pid: 101,
    processTag: ALFRED_SERVER_PROCESS_TAG,
    now: () => "2026-08-24T00:00:00.000Z",
    tokenFactory: () => "first-token",
    isProcessAlive: (pid) => pid === 101
  });
  await first.acquire();

  const second = new PidLock({
    lockPath,
    pid: 202,
    isProcessAlive: (pid) => pid === 101
  });
  await assert.rejects(
    second.acquire(),
    (error: unknown) => error instanceof PidLockAlreadyHeldError && error.owner?.pid === 101
  );

  const record = JSON.parse(await readFile(lockPath, "utf8")) as { token: string };
  assert.equal(record.token, "first-token");
  await first.release();
  await assert.rejects(readFile(lockPath, "utf8"), { code: "ENOENT" });
});

test("PID lock quarantines a stale owner without deleting a concurrently acquired lock", async () => {
  const workspace = await createTempWorkspace("alfred-pid-lock-stale");
  const lockPath = path.join(workspace, "alfred.pid");
  await writeFile(lockPath, JSON.stringify({
    pid: 303,
    startedAt: "2020-01-01T00:00:00.000Z",
    token: "stale-token",
    processTag: "alfred-server"
  }));

  const lock = new PidLock({
    lockPath,
    pid: 404,
    tokenFactory: () => "fresh-token",
    isProcessAlive: () => false
  });
  await lock.acquire();
  const record = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; startedAt: string; token: string; processTag: string };
  assert.deepEqual(record, { pid: 404, startedAt: record.startedAt, token: "fresh-token", processTag: process.title });
  await lock.release();
});

test("simultaneous PID lock acquisition has exactly one winner", async () => {
  const workspace = await createTempWorkspace("alfred-pid-lock-race");
  const lockPath = path.join(workspace, "alfred.pid");
  const makeLock = (pid: number) => new PidLock({
    lockPath,
    pid,
    tokenFactory: () => `token-${pid}`,
    isProcessAlive: (ownerPid) => ownerPid === 505 || ownerPid === 606
  });
  const locks = [makeLock(505), makeLock(606)];
  const results = await Promise.allSettled(locks.map((lock) => lock.acquire()));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await Promise.all(locks.map((lock) => lock.release()));
});

test("managed process tags identify Alfred descendants", () => {
  assert.equal(managedProcessTag("searxng"), "alfred-server:managed:searxng");
  assert.equal(managedProcessTag("sub agent / Pi"), "alfred-server:managed:sub-agent-Pi");
});
