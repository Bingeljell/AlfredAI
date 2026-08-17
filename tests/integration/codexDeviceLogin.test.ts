import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

test("Codex device login keeps the CLI process alive through pending polls", async () => {
  const oauthModule = pathToFileURL(path.resolve(process.cwd(), "src/provider/codex/oauth.ts")).href;
  const source = `
    import { CODEX_OAUTH_CONSTANTS, loginCodexDevice } from ${JSON.stringify(oauthModule)};
    let polls = 0;
    const accessToken = "e30." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth.chatgpt_account_id": "acct-cli" })).toString("base64url") + ".signature";
    const fetchImpl = async (url) => {
      if (String(url) === CODEX_OAUTH_CONSTANTS.deviceUserCodeEndpoint) {
        return new Response(JSON.stringify({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: 0.02 }), { status: 200 });
      }
      if (String(url) === CODEX_OAUTH_CONSTANTS.deviceTokenEndpoint) {
        polls += 1;
        if (polls < 3) return new Response("pending", { status: 403 });
        return new Response(JSON.stringify({ authorization_code: "authorization-code", code_verifier: "verifier" }), { status: 200 });
      }
      if (String(url) === CODEX_OAUTH_CONSTANTS.tokenEndpoint) {
        return new Response(JSON.stringify({ access_token: accessToken, refresh_token: "refresh-cli", expires_in: 3600 }), { status: 200 });
      }
      throw new Error("unexpected URL");
    };
    const result = await loginCodexDevice({ fetchImpl, deviceTimeoutMs: 1000 });
    if (polls !== 3 || result.accountId !== "acct-cli") throw new Error("device login did not complete after pending polls");
    console.log("device-login-complete");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  clearTimeout(killTimer);
  assert.equal(exitCode, 0, stderr || stdout);
  assert.match(stdout, /device-login-complete/);
});
