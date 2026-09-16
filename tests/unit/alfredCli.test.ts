import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("Alfred CLI exposes package-safe help without constructing provider services", async () => {
  const output: string[] = [];
  const result = await runCli(["--help"], { write: (line) => output.push(line) });
  assert.equal(result, 0);
  assert.match(output.join("\n"), /alfred start/);
  assert.match(output.join("\n"), /alfred migrate home/);
});

test("Alfred CLI setup and doctor initialize an isolated Codex-backed home", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "alfred-cli-home-"));
  const target = path.join(home, "instance");
  const output: string[] = [];
  assert.equal(await runCli(["setup", "--name", "Ada", "--provider", "codex", "--access", "limited", "--home", target], { write: (line) => output.push(line) }), 0);
  assert.match(await readFile(path.join(target, "identity", "SOUL.md"), "utf8"), /Ada/);
  assert.match(await readFile(path.join(target, "config", "config.env"), "utf8"), /ALFRED_LLM_PROVIDER=codex/);
  assert.match(await readFile(path.join(target, "config", "config.env"), "utf8"), /ALFRED_ACCESS_MODE=limited/);
  assert.equal(await runCli(["doctor", "--home", target, "--json"], { write: (line) => output.push(line) }), 0);
  assert.equal(output.join("\n").includes("accessToken"), false);
});

test("Alfred CLI delegates service operations without touching launchctl", async () => {
  const output: string[] = [];
  const actions: string[] = [];
  const result = await runCli(["service", "restart"], {
    write: (line) => output.push(line),
    serviceManager: {
      async install() { throw new Error("unexpected"); },
      async status() { throw new Error("unexpected"); },
      async uninstall() { throw new Error("unexpected"); },
      async restart() {
        actions.push("restart");
        return { action: "restart", label: "com.alfred.agent", plistPath: "/tmp/test.plist", installed: true, running: true, message: "restarted" };
      }
    }
  });
  assert.equal(result, 0);
  assert.deepEqual(actions, ["restart"]);
  assert.match(output.join("\n"), /com\.alfred\.agent/);
});
