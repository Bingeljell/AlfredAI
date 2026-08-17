import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEX_OAUTH_CONSTANTS = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  browserRedirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  deviceUserCodeEndpoint: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenEndpoint: "https://auth.openai.com/api/accounts/deviceauth/token",
  deviceVerificationUrl: "https://auth.openai.com/codex/device",
  deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
  deviceTimeoutMs: 15 * 60 * 1000
} as const;

export interface CodexOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  accountId: string;
}

export interface CodexOAuthFlowOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  browserTimeoutMs?: number;
  deviceTimeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  onAuthUrl?: (url: string) => void;
  onDeviceCode?: (info: { verificationUrl: string; userCode: string; intervalSeconds: number; expiresInSeconds: number }) => void;
}

function getFetch(options: CodexOAuthFlowOptions): typeof fetch {
  return options.fetchImpl ?? fetch;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Codex login cancelled.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Codex login cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Codex login cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function createState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function extractCodexAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const exact = payload?.["https://api.openai.com/auth.chatgpt_account_id"];
  if (typeof exact === "string" && exact.trim()) return exact.trim();
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const nested = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return undefined;
}

export async function readCodexTokenResponse(response: Response, operation: "exchange" | "refresh"): Promise<CodexOAuthToken> {
  if (!response.ok) {
    throw new Error(`Codex OAuth token ${operation} failed (HTTP ${response.status}).`);
  }
  let payload: Record<string, unknown>;
  try {
    const json = await response.json() as unknown;
    payload = json && typeof json === "object" ? json as Record<string, unknown> : {};
  } catch {
    throw new Error(`Codex OAuth token ${operation} returned invalid JSON.`);
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number.NaN;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`Codex OAuth token ${operation} response is invalid.`);
  }
  const accountId = extractCodexAccountId(accessToken);
  if (!accountId) throw new Error("Codex OAuth token did not contain an account ID.");
  return { accessToken, refreshToken, expiresAtMs: Date.now() + Math.round(expiresIn * 1000), accountId };
}

async function postFormToken(args: {
  body: URLSearchParams;
  operation: "exchange" | "refresh";
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<CodexOAuthToken> {
  assertNotAborted(args.signal);
  let response: Response;
  try {
    response = await args.fetchImpl(CODEX_OAUTH_CONSTANTS.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: args.body,
      signal: args.signal
    });
  } catch {
    if (args.signal?.aborted) throw new Error("Codex login cancelled.");
    throw new Error(`Codex OAuth token ${args.operation} request failed.`);
  }
  return readCodexTokenResponse(response, args.operation);
}

export async function exchangeCodexAuthorizationCode(args: {
  code: string;
  verifier: string;
  redirectUri: string;
  options?: CodexOAuthFlowOptions;
}): Promise<CodexOAuthToken> {
  const options = args.options ?? {};
  return postFormToken({
    fetchImpl: getFetch(options),
    signal: options.signal,
    operation: "exchange",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CONSTANTS.clientId,
      code: args.code,
      code_verifier: args.verifier,
      redirect_uri: args.redirectUri
    })
  });
}

export async function refreshCodexAccessToken(refreshToken: string, options: CodexOAuthFlowOptions = {}): Promise<CodexOAuthToken> {
  return postFormToken({
    fetchImpl: getFetch(options),
    signal: options.signal,
    operation: "refresh",
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CONSTANTS.clientId
    })
  });
}

interface CallbackServer {
  server: Server;
  waitForCode: Promise<string>;
}

export function startCodexCallbackServer(state: string): Promise<CallbackServer> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) {
        response.statusCode = 400;
        response.end("State mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        response.statusCode = 400;
        response.end("Missing authorization code");
        return;
      }
      response.statusCode = 200;
      response.end("Codex login complete. You can close this window.");
      resolveCode(code);
    } catch {
      response.statusCode = 500;
      response.end("OAuth callback failed");
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", () => {
      rejectCode(new Error("Codex OAuth callback server could not bind to 127.0.0.1:1455."));
      reject(new Error("Codex OAuth callback server could not bind to 127.0.0.1:1455."));
    });
    server.listen(1455, "127.0.0.1", () => resolve({ server, waitForCode }));
  });
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await execFileAsync(command, args);
}

export async function loginCodexBrowser(options: CodexOAuthFlowOptions = {}): Promise<CodexOAuthToken> {
  const { verifier, challenge } = createPkce();
  const state = createState();
  const authUrl = new URL(CODEX_OAUTH_CONSTANTS.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CODEX_OAUTH_CONSTANTS.clientId);
  authUrl.searchParams.set("redirect_uri", CODEX_OAUTH_CONSTANTS.browserRedirectUri);
  authUrl.searchParams.set("scope", CODEX_OAUTH_CONSTANTS.scope);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");

  const callback = await startCodexCallbackServer(state);
  const timeoutMs = options.browserTimeoutMs ?? CODEX_OAUTH_CONSTANTS.deviceTimeoutMs;
  const timeout = setTimeout(() => callback.server.close(), timeoutMs);
  timeout.unref?.();
  options.onAuthUrl?.(authUrl.toString());
  try {
    assertNotAborted(options.signal);
    try {
      await (options.openBrowser ?? defaultOpenBrowser)(authUrl.toString());
    } catch {
      // The URL was already delivered through onAuthUrl; keep waiting for the callback.
    }
    const code = await Promise.race([
      callback.waitForCode,
      sleep(timeoutMs, options.signal).then(() => { throw new Error("Codex browser login timed out."); })
    ]);
    return exchangeCodexAuthorizationCode({
      code,
      verifier,
      redirectUri: CODEX_OAUTH_CONSTANTS.browserRedirectUri,
      options
    });
  } finally {
    clearTimeout(timeout);
    callback.server.close();
  }
}

export async function loginCodexDevice(options: CodexOAuthFlowOptions = {}): Promise<CodexOAuthToken> {
  const fetchImpl = getFetch(options);
  assertNotAborted(options.signal);
  let response: Response;
  try {
    response = await fetchImpl(CODEX_OAUTH_CONSTANTS.deviceUserCodeEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CONSTANTS.clientId }),
      signal: options.signal
    });
  } catch {
    if (options.signal?.aborted) throw new Error("Codex login cancelled.");
    throw new Error("Codex device login request failed.");
  }
  if (!response.ok) throw new Error(`Codex device login request failed (HTTP ${response.status}).`);

  let payload: Record<string, unknown>;
  try {
    const json = await response.json() as unknown;
    payload = json && typeof json === "object" ? json as Record<string, unknown> : {};
  } catch {
    throw new Error("Codex device login returned invalid JSON.");
  }
  const deviceAuthId = typeof payload.device_auth_id === "string" ? payload.device_auth_id : "";
  const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
  const intervalRaw = payload.interval;
  const intervalSeconds = typeof intervalRaw === "string" && intervalRaw.trim() ? Number(intervalRaw) : intervalRaw;
  if (!deviceAuthId || !userCode || typeof intervalSeconds !== "number" || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("Codex device login returned an invalid challenge.");
  }
  options.onDeviceCode?.({
    verificationUrl: CODEX_OAUTH_CONSTANTS.deviceVerificationUrl,
    userCode,
    intervalSeconds,
    expiresInSeconds: CODEX_OAUTH_CONSTANTS.deviceTimeoutMs / 1000
  });

  const deadline = Date.now() + (options.deviceTimeoutMs ?? CODEX_OAUTH_CONSTANTS.deviceTimeoutMs);
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await sleep(Math.min(intervalSeconds * 1000, remainingMs), options.signal);
    if (Date.now() >= deadline) break;
    assertNotAborted(options.signal);
    let pollResponse: Response;
    try {
      pollResponse = await fetchImpl(CODEX_OAUTH_CONSTANTS.deviceTokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal: options.signal
      });
    } catch {
      if (options.signal?.aborted) throw new Error("Codex login cancelled.");
      throw new Error("Codex device login polling failed.");
    }
    if (pollResponse.ok) {
      let result: Record<string, unknown>;
      try {
        const json = await pollResponse.json() as unknown;
        result = json && typeof json === "object" ? json as Record<string, unknown> : {};
      } catch {
        throw new Error("Codex device login returned invalid JSON.");
      }
      const code = typeof result.authorization_code === "string" ? result.authorization_code : "";
      const verifier = typeof result.code_verifier === "string" ? result.code_verifier : "";
      if (!code || !verifier) throw new Error("Codex device login returned an invalid authorization result.");
      return exchangeCodexAuthorizationCode({
        code,
        verifier,
        redirectUri: CODEX_OAUTH_CONSTANTS.deviceRedirectUri,
        options
      });
    }
    if (pollResponse.status === 403 || pollResponse.status === 404) continue;
    throw new Error(`Codex device login failed (HTTP ${pollResponse.status}).`);
  }
  throw new Error("Codex device login timed out.");
}
