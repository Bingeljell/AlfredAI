import {
  codexCredentialsFromOAuthToken,
  getCodexCredentials,
  readCodexCredentials,
  removeCodexCredentials,
  resolveCodexAuthPath,
  writeCodexCredentials
} from "../src/provider/codex/auth.js";
import { loginCodexBrowser, loginCodexDevice } from "../src/provider/codex/oauth.js";

const command = process.argv[2] ?? "";
const device = process.argv.includes("--device");

function createSignal(): AbortController {
  const controller = new AbortController();
  const onSignal = () => controller.abort("caller_cancellation");
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return controller;
}

async function main(): Promise<void> {
  const authPath = resolveCodexAuthPath();
  if (command === "login") {
    const controller = createSignal();
    try {
      const token = device
        ? await loginCodexDevice({
            signal: controller.signal,
            onDeviceCode: (info) => {
              console.log(`Open ${info.verificationUrl} and enter code ${info.userCode}.`);
            }
          })
        : await loginCodexBrowser({
            signal: controller.signal,
            onAuthUrl: (url) => console.log(`Open this URL to sign in: ${url}`)
          });
      await writeCodexCredentials(codexCredentialsFromOAuthToken(token), authPath);
      console.log(`Codex login saved. Account ending in ${token.accountId.slice(-4)}.`);
      return;
    } finally {
      controller.abort();
    }
  }

  if (command === "status") {
    try {
      const credentials = await readCodexCredentials(authPath);
      const active = credentials.expiresAtMs > Date.now();
      console.log(`Codex login: ${active ? "active" : "expired"}`);
      console.log(`Expires: ${new Date(credentials.expiresAtMs).toISOString()}`);
      console.log(`Account ending in: ${credentials.accountId.slice(-4)}`);
      if (!active) process.exitCode = 1;
    } catch {
      console.log(`Codex login: not active`);
      console.log("Run pnpm codex:login.");
      process.exitCode = 1;
    }
    return;
  }

  if (command === "logout") {
    await removeCodexCredentials(authPath);
    console.log("Codex login removed from Alfred.");
    return;
  }

  throw new Error("Usage: pnpm codex:login [-- --device] | pnpm codex:status | pnpm codex:logout");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Codex command failed.");
  process.exitCode = 1;
});
