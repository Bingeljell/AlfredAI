import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexAccountService } from "../../src/provider/codex/accountService.js";
import type { AppServerNotification } from "../../src/provider/codex/appServerClient.js";

class FakeAccountClient {
  readonly notifications = new EventEmitter();
  initializeCalls = 0;
  requests: Array<{ method: string; params: unknown }> = [];

  async initialize(): Promise<Record<string, unknown>> {
    this.initializeCalls += 1;
    return {};
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === "account/read") return { requiresOpenaiAuth: false, account: { type: "chatgpt", email: "owner@example.com", planType: "plus" } } as T;
    if (method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.example/device", userCode: "ABCD-EFGH" } as T;
    if (method === "account/login/cancel") return { status: "cancelled" } as T;
    return {} as T;
  }

  subscribeNotifications(listener: (notification: AppServerNotification) => void): () => void {
    this.notifications.on("notification", listener);
    return () => this.notifications.off("notification", listener);
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

test("account service rejects login responses that do not include official short-lived login details", async () => {
  const client = new FakeAccountClient();
  client.request = async <T>(method: string) => method === "account/login/start" ? ({ type: "chatgptDeviceCode", loginId: "login-1" } as T) : ({} as T);
  const service = new CodexAccountService(client);
  await assert.rejects(service.startLogin("device-code"), /did not return a device code/);
});
