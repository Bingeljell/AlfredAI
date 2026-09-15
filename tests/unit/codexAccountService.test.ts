import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexAccountService } from "../../src/provider/codex/accountService.js";
import type { AppServerNotification } from "../../src/provider/codex/appServerClient.js";

class FakeAccountClient {
  readonly notifications = new EventEmitter();
  initializeCalls = 0;
  closeCalls = 0;
  requests: Array<{ method: string; params: unknown }> = [];
  synchronousCompletion?: { success: boolean; error?: string };

  async initialize(): Promise<Record<string, unknown>> {
    this.initializeCalls += 1;
    return {};
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") return { requiresOpenaiAuth: false, account: { type: "chatgpt", email: "owner@example.com", planType: "plus" } } as T;
    if (method === "account/login/start" && (params as { type?: string })?.type === "chatgpt") {
      if (this.synchronousCompletion) {
        this.emit({ method: "account/login/completed", params: { loginId: "login-1", ...this.synchronousCompletion } });
      }
      return { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/login" } as T;
    }
    if (method === "account/login/start") {
      if (this.synchronousCompletion) {
        this.emit({ method: "account/login/completed", params: { loginId: "login-1", ...this.synchronousCompletion } });
      }
      return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-EFGH" } as T;
    }
    if (method === "account/login/cancel") return { status: "cancelled" } as T;
    return {} as T;
  }

  subscribeNotifications(listener: (notification: AppServerNotification) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emit(notification: AppServerNotification): void {
    this.notifications.emit("notification", notification);
  }
}

test("account service exposes sanitized account state and never returns credential fields", async () => {
  const client = new FakeAccountClient();
  const service = new CodexAccountService(client);
  const account = await service.readAccount();
  assert.deepEqual(account, { connected: true, requiresOpenaiAuth: false, authMode: "chatgpt", email: "owner@example.com", planType: "plus" });
  assert.equal(client.initializeCalls, 1);
  assert.deepEqual(client.requests[0], { method: "account/read", params: { refreshToken: false } });
  assert.equal(JSON.stringify(account).includes("token"), false);
});

test("account service supports browser/device login progress, cancellation, and completion notifications", async () => {
  const client = new FakeAccountClient();
  const service = new CodexAccountService(client);
  const progress: string[] = [];
  service.subscribeLogin((value) => progress.push(`${value.loginId}:${value.status}`));
  const login = await service.startLogin("device-code");
  assert.deepEqual(login, { mode: "device-code", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-EFGH" });
  client.emit({ method: "account/login/completed", params: { loginId: "login-1", success: true, error: null } });
  assert.deepEqual(await service.getLogin("login-1"), { loginId: "login-1", mode: "device-code", status: "completed", error: undefined });
  await service.cancelLogin("login-1");
  assert.deepEqual(progress, ["login-1:started", "login-1:completed", "login-1:cancelled"]);
  assert.equal(client.requests.some((request) => request.method === "account/login/cancel"), true);
});

test("account service waits for successful and failed login completion without exposing credentials", async () => {
  const successClient = new FakeAccountClient();
  const successService = new CodexAccountService(successClient);
  const successLogin = await successService.startLogin("device-code");
  const successWait = successService.waitForLogin(successLogin.loginId, { timeoutMs: 2_000 });
  successClient.emit({ method: "account/login/completed", params: { loginId: successLogin.loginId, success: true } });
  assert.equal((await successWait).status, "completed");

  const failureClient = new FakeAccountClient();
  const failureService = new CodexAccountService(failureClient);
  const failureLogin = await failureService.startLogin("browser");
  const failureWait = failureService.waitForLogin(failureLogin.loginId, { timeoutMs: 2_000 });
  failureClient.emit({ method: "account/login/completed", params: { loginId: failureLogin.loginId, success: false, error: "denied" } });
  const failed = await failureWait;
  assert.deepEqual({ status: failed.status, error: failed.error }, { status: "failed", error: "denied" });
  assert.equal(JSON.stringify(failed).includes("accessToken"), false);
});

test("account service preserves a synchronous completion notification emitted before the login-start response", async () => {
  const client = new FakeAccountClient();
  client.synchronousCompletion = { success: true };
  const service = new CodexAccountService(client);

  const login = await service.startLogin("device-code");
  assert.deepEqual(service.getLogin(login.loginId), {
    loginId: "login-1",
    mode: "device-code",
    status: "completed",
    verificationUrl: "https://auth.example/device",
    userCode: "ABCD-EFGH",
    authorizationUrl: undefined,
    error: undefined
  });
  assert.equal((await service.waitForLogin(login.loginId)).status, "completed");
});

test("account service cancels timed-out and signal-cancelled logins and closes cleanly", async () => {
  const timeoutClient = new FakeAccountClient();
  const timeoutService = new CodexAccountService(timeoutClient);
  const timeoutLogin = await timeoutService.startLogin("device-code");
  const timedOut = await timeoutService.waitForLogin(timeoutLogin.loginId, { timeoutMs: 1_000 });
  assert.equal(timedOut.status, "cancelled");
  assert.equal(timedOut.error, "Login timed out; the pending App Server login was cancelled");
  assert.equal(timeoutClient.requests.at(-1)?.method, "account/login/cancel");
  await timeoutService.close();
  assert.equal(timeoutClient.closeCalls, 1);

  const cancelClient = new FakeAccountClient();
  const cancelService = new CodexAccountService(cancelClient);
  const cancelLogin = await cancelService.startLogin("device-code");
  const controller = new AbortController();
  const cancelled = cancelService.waitForLogin(cancelLogin.loginId, { timeoutMs: 2_000, signal: controller.signal });
  controller.abort();
  const cancelledProgress = await cancelled;
  assert.equal(cancelledProgress.status, "cancelled");
  assert.equal(cancelledProgress.error, "Login cancelled by user");
  assert.equal(cancelClient.requests.at(-1)?.method, "account/login/cancel");
  await cancelService.close();
  assert.equal(cancelClient.closeCalls, 1);
});

test("account service rejects login responses that do not include official short-lived login details", async () => {
  const client = new FakeAccountClient();
  client.request = async <T>(method: string) => method === "account/login/start" ? ({ type: "chatgptDeviceCode", loginId: "login-1" } as T) : ({} as T);
  const service = new CodexAccountService(client);
  await assert.rejects(service.startLogin("device-code"), /did not return a device code/);
});
