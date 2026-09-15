import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runCli, type AlfredCliOptions } from "../../scripts/alfred-cli.js";

class FakeSignalSource extends EventEmitter {}

function signalSource(): FakeSignalSource & NodeJS.Process {
  return new FakeSignalSource() as FakeSignalSource & NodeJS.Process;
}

function fakeService(overrides: Partial<NonNullable<AlfredCliOptions["service"]>> = {}) {
  let closed = false;
  const service = {
    async startLogin() {
      return { mode: "browser" as const, loginId: "login-1", authorizationUrl: "https://auth.example/login" };
    },
    async waitForLogin() {
      return { loginId: "login-1", mode: "browser" as const, status: "completed" as const };
    },
    async readAccount() {
      return { connected: false, requiresOpenaiAuth: true, authMode: null, email: null, planType: null };
    },
    async logout() {},
    async close() {
      closed = true;
    },
    ...overrides
  } satisfies NonNullable<AlfredCliOptions["service"]>;
  return { service, wasClosed: () => closed };
}

test("Alfred CLI prints actionable login instructions and always cleans up", async () => {
  const output: string[] = [];
  const fake = fakeService();
  const result = await runCli(["auth", "login", "openai"], { service: fake.service, write: (line) => output.push(line) });
  assert.equal(result, 0);
  assert.equal(output.some((line) => line.includes("https://auth.example/login")), true);
  assert.equal(output.some((line) => line.includes("completed")), true);
  assert.equal(fake.wasClosed(), true);
  assert.equal(output.join("\n").includes("accessToken"), false);
});

test("Alfred CLI cancels the App Server login on Ctrl-C and closes the client", async () => {
  const output: string[] = [];
  const source = signalSource();
  let cancelObserved = false;
  const fake = fakeService({
    async waitForLogin(_loginId, options) {
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          cancelObserved = true;
          resolve({ loginId: "login-1", mode: "browser", status: "cancelled", error: "Login cancelled by user" });
        }, { once: true });
      });
    }
  });
  const pending = runCli(["auth", "login", "openai"], {
    service: fake.service,
    signalSource: source,
    write: (line) => output.push(line)
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  source.emit("SIGINT");
  assert.equal(await pending, 130);
  assert.equal(cancelObserved, true);
  assert.equal(fake.wasClosed(), true);
});
