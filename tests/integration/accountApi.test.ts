import test from "node:test";
import assert from "node:assert/strict";
import { app, setCodexAccountServiceForTests } from "../../src/gateway/app.js";
import type { OpenAiLoginProgress } from "../../src/provider/codex/accountService.js";

class FakeAccountService {
  login: OpenAiLoginProgress = {
    loginId: "login-test",
    mode: "device-code",
    status: "started",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH"
  };

  async readAccount() {
    return { connected: true, requiresOpenaiAuth: false, authMode: "chatgpt" as const, email: "owner@example.com", planType: "plus" as const };
  }

  async startLogin() {
    return { mode: "device-code" as const, loginId: this.login.loginId, verificationUrl: this.login.verificationUrl, userCode: this.login.userCode };
  }

  getLogin() {
    return this.login;
  }

  async cancelLogin() {
    this.login = { ...this.login, status: "cancelled" };
    return { status: "cancelled" };
  }

  async logout() {}
}

test("OpenAI account routes are authenticated response-cache safe and redact credentials", async () => {
  const service = new FakeAccountService();
  setCodexAccountServiceForTests(service as never);
  const accountResponse = await app.request("http://localhost/v1/accounts/openai");
  assert.equal(accountResponse.status, 200);
  assert.equal(accountResponse.headers.get("cache-control"), "no-store");
  assert.equal(accountResponse.headers.get("pragma"), "no-cache");
  const accountBody = await accountResponse.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(accountBody).includes("token"), false);

  const loginResponse = await app.request("http://localhost/v1/accounts/openai/login/device", { method: "POST" });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("cache-control"), "no-store");
  const loginBody = await loginResponse.json() as Record<string, unknown>;
  assert.deepEqual(loginBody, { mode: "device-code", loginId: "login-test", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
  assert.equal(JSON.stringify(loginBody).includes("accessToken"), false);

  const progressResponse = await app.request("http://localhost/v1/accounts/openai/login/login-test");
  assert.equal(progressResponse.status, 200);
  assert.equal((await progressResponse.json() as Record<string, unknown>).status, "started");

  const cancelResponse = await app.request("http://localhost/v1/accounts/openai/login/login-test", { method: "DELETE" });
  assert.equal(cancelResponse.status, 200);
  const logoutResponse = await app.request("http://localhost/v1/accounts/openai/logout", { method: "POST" });
  assert.equal(logoutResponse.status, 200);
});
