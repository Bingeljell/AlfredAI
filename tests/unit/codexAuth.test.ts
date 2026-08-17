import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_LOGIN_INVALID,
  getCodexCredentials,
  readCodexCredentials,
  resolveCodexAuthPath,
  writeCodexCredentials
} from "../../src/provider/codex/auth.js";

function token(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": accountId })).toString("base64url");
  return `${header}.${payload}.signature`;
}

async function withTemp<T>(fn: (dir: string, authPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "alfred-codex-auth-"));
  try {
    return await fn(dir, path.join(dir, "codex-auth.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Codex credentials are schema-validated and written atomically with restricted modes", async () => {
  await withTemp(async (dir, authPath) => {
    await writeCodexCredentials({ version: 1, provider: "codex", accessToken: token("acct-valid"), refreshToken: "refresh-valid", expiresAtMs: Date.now() + 3_600_000, accountId: "acct-valid" }, authPath);
    const value = await readCodexCredentials(authPath);
    assert.equal(value.accountId, "acct-valid");
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  });
});

test("Codex invalid credentials return the actionable safe error", async () => {
  await withTemp(async (_dir, authPath) => {
    await writeFile(authPath, "{broken", "utf8");
    await assert.rejects(() => readCodexCredentials(authPath), (error: unknown) => error instanceof Error && error.message === CODEX_LOGIN_INVALID);
  });
});

test("Codex auth rejects repository-local paths and existing symlinks", async () => {
  assert.throws(() => resolveCodexAuthPath(path.join(process.cwd(), "codex-auth.json")), /outside the Alfred repository/);
  await withTemp(async (dir, authPath) => {
    const target = path.join(dir, "real-auth.json");
    await writeFile(target, "{}", "utf8");
    await symlink(target, authPath);
    await assert.rejects(() => readCodexCredentials(authPath), /must not be a symlink/);
  });
});

test("Codex refresh is deduplicated and persists rotated tokens", async () => {
  await withTemp(async (_dir, authPath) => {
    const oldToken = token("acct-old");
    await writeCodexCredentials({ version: 1, provider: "codex", accessToken: oldToken, refreshToken: "refresh-old", expiresAtMs: Date.now() - 1, accountId: "acct-old" }, authPath);
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      refreshCalls += 1;
      return new Response(JSON.stringify({ access_token: token("acct-new"), refresh_token: "refresh-new", expires_in: 3600 }), { status: 200 });
    };
    const [first, second] = await Promise.all([
      getCodexCredentials({ authFilePath: authPath, fetchImpl }),
      getCodexCredentials({ authFilePath: authPath, fetchImpl })
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.refreshToken, "refresh-new");
    assert.equal(second.accountId, "acct-new");
  });
});
