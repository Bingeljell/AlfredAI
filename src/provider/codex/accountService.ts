import { CodexAppServerClient, type AppServerNotification } from "./appServerClient.js";

export type OpenAiLoginMode = "browser" | "device-code";
export type OpenAiPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "edu_plus"
  | "edu_pro"
  | "unknown";

export interface OpenAiAccountState {
  connected: boolean;
  requiresOpenaiAuth: boolean;
  authMode: "chatgpt" | "apikey" | "other" | null;
  email: string | null;
  planType: OpenAiPlanType | null;
}

export interface OpenAiLoginStart {
  mode: OpenAiLoginMode;
  loginId: string;
  authorizationUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

export type OpenAiLoginStatus = "started" | "completed" | "failed" | "cancelled";

export interface OpenAiLoginProgress {
  loginId: string;
  mode: OpenAiLoginMode;
  status: OpenAiLoginStatus;
  error?: string;
  authorizationUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface AccountClient {
  initialize(params: { clientInfo: { name: string; version: string }; capabilities?: { experimentalApi?: boolean } }): Promise<Record<string, unknown>>;
  request<T>(method: string, params: unknown): Promise<T>;
  subscribeNotifications?(listener: (notification: AppServerNotification) => void): () => void;
  close?(): Promise<void>;
  readonly isConnected?: boolean;
}

interface LoginSubscriber {
  (progress: OpenAiLoginProgress): void;
}

const PLAN_TYPES = new Set<OpenAiPlanType>([
  "free", "go", "plus", "pro", "prolite", "team", "self_serve_business_prolite",
  "self_serve_business_usage_based", "business", "ent26", "enterprise_cbp_automation",
  "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "unknown"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function planOrNull(value: unknown): OpenAiPlanType | null {
  return typeof value === "string" && PLAN_TYPES.has(value as OpenAiPlanType) ? value as OpenAiPlanType : null;
}

function safeErrorMessage(value: unknown): string | undefined {
  const message = typeof value === "string" ? value : undefined;
  return message ? message.slice(0, 300) : undefined;
}

function mapAccountState(response: unknown): OpenAiAccountState {
  const body = isRecord(response) ? response : {};
  const account = isRecord(body.account) ? body.account : undefined;
  const type = stringOrNull(account?.type);
  return {
    connected: Boolean(account),
    requiresOpenaiAuth: body.requiresOpenaiAuth === true,
    authMode: type === "chatgpt" ? "chatgpt" : type === "apiKey" ? "apikey" : type ? "other" : null,
    email: type === "chatgpt" ? stringOrNull(account?.email) : null,
    planType: type === "chatgpt" ? planOrNull(account?.planType) : null
  };
}

function mapLoginStart(mode: OpenAiLoginMode, response: unknown): OpenAiLoginStart {
  const body = isRecord(response) ? response : {};
  const loginId = stringOrNull(body.loginId);
  if (!loginId) throw new Error("Codex App Server did not return a login id");
  if (mode === "browser" && typeof body.authUrl !== "string") throw new Error("Codex App Server did not return an authorization URL");
  if (mode === "device-code" && (typeof body.verificationUrl !== "string" || typeof body.userCode !== "string")) {
    throw new Error("Codex App Server did not return a device code");
  }
  return mode === "device-code"
    ? { mode, loginId, verificationUrl: body.verificationUrl as string, userCode: body.userCode as string }
    : { mode, loginId, authorizationUrl: body.authUrl as string };
}

export class CodexAccountService {
  private readonly client: AccountClient;
  private initialized = false;
  private readonly loginProgress = new Map<string, OpenAiLoginProgress>();
  private readonly subscribers = new Set<LoginSubscriber>();
  private unsubscribeNotifications?: () => void;

  constructor(client: AccountClient = new CodexAppServerClient()) {
    this.client = client;
    this.unsubscribeNotifications = client.subscribeNotifications?.((notification) => this.handleNotification(notification));
  }

  get appServerClient(): AccountClient {
    return this.client;
  }

  subscribeLogin(listener: LoginSubscriber): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async initialize(): Promise<void> {
    if (this.initialized && this.client.isConnected !== false) return;
    this.initialized = false;
    await this.client.initialize({
      clientInfo: { name: "alfred", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.initialized = true;
  }

  async readAccount(): Promise<OpenAiAccountState> {
    await this.initialize();
    try {
      const response = await this.client.request<Record<string, unknown>>("account/read", { refreshToken: false });
      return mapAccountState(response);
    } catch (error) {
      if (this.client.isConnected === false) this.initialized = false;
      throw error;
    }
  }

  async startLogin(mode: OpenAiLoginMode): Promise<OpenAiLoginStart> {
    await this.initialize();
    const response = await this.client.request<unknown>("account/login/start", mode === "browser"
      ? { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" }
      : { type: "chatgptDeviceCode" });
    const start = mapLoginStart(mode, response);
    const instructions = {
      loginId: start.loginId,
      mode,
      authorizationUrl: start.authorizationUrl,
      verificationUrl: start.verificationUrl,
      userCode: start.userCode
    } satisfies Pick<OpenAiLoginProgress, "loginId" | "mode" | "authorizationUrl" | "verificationUrl" | "userCode">;
    const existing = this.loginProgress.get(start.loginId);
    if (existing && existing.status !== "started") {
      // The App Server may deliver account/login/completed in the same stdout
      // batch as the start response. Preserve that terminal state while adding
      // the mode and public instructions that only the response contains.
      this.loginProgress.set(start.loginId, { ...existing, ...instructions });
    } else {
      this.publish({
        ...instructions,
        status: "started"
      });
    }
    return start;
  }

  getLogin(loginId: string): OpenAiLoginProgress | undefined {
    const progress = this.loginProgress.get(loginId);
    return progress ? { ...progress } : undefined;
  }

  async waitForLogin(loginId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OpenAiLoginProgress> {
    const current = this.loginProgress.get(loginId);
    if (current && current.status !== "started") return { ...current };
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10 * 60_000);
    return new Promise<OpenAiLoginProgress>((resolve) => {
      let settled = false;
      let cancellationReason: string | undefined;
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe: (() => void) | undefined;
      const finish = (progress: OpenAiLoginProgress): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ ...progress });
      };
      const cancel = async (error: string): Promise<void> => {
        cancellationReason = error;
        try {
          await this.cancelLogin(loginId);
        } catch {
          this.publish({
            loginId,
            mode: this.loginProgress.get(loginId)?.mode ?? "browser",
            status: "failed",
            error: "Unable to cancel the App Server login"
          });
        }
        const progress = this.loginProgress.get(loginId) ?? {
          loginId,
          mode: "browser" as const,
          status: "cancelled" as const
        };
        if (progress.status === "cancelled") {
          finish({ ...progress, error: progress.error ?? error });
        } else {
          finish({ ...progress, status: "cancelled", error });
        }
      };
      const onAbort = (): void => {
        void cancel("Login cancelled by user");
      };
      unsubscribe = this.subscribeLogin((progress) => {
        if (progress.loginId === loginId && progress.status !== "started") {
          finish(progress.status === "cancelled" && cancellationReason
            ? { ...progress, error: cancellationReason }
            : progress);
        }
      });
      timer = setTimeout(() => {
        void cancel("Login timed out; the pending App Server login was cancelled");
      }, timeoutMs);
      timer.unref?.();
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
      const afterSubscribe = this.loginProgress.get(loginId);
      if (afterSubscribe && afterSubscribe.status !== "started") finish(afterSubscribe);
    });
  }

  async cancelLogin(loginId: string): Promise<{ status: string }> {
    await this.initialize();
    const response = await this.client.request<{ status?: string }>("account/login/cancel", { loginId });
    this.publish({
      loginId,
      mode: this.loginProgress.get(loginId)?.mode ?? "browser",
      status: "cancelled"
    });
    return { status: typeof response?.status === "string" ? response.status : "cancelled" };
  }

  async logout(): Promise<void> {
    await this.initialize();
    await this.client.request("account/logout", undefined);
  }

  async close(): Promise<void> {
    this.unsubscribeNotifications?.();
    this.unsubscribeNotifications = undefined;
    await this.client.close?.();
  }

  private handleNotification(notification: AppServerNotification): void {
    if (notification.method !== "account/login/completed") return;
    const params = isRecord(notification.params) ? notification.params : {};
    const loginId = stringOrNull(params.loginId);
    if (!loginId) return;
    const previous = this.loginProgress.get(loginId);
    this.publish({
      loginId,
      mode: previous?.mode ?? "browser",
      status: params.success === true ? "completed" : "failed",
      error: safeErrorMessage(params.error)
    });
  }

  private publish(progress: OpenAiLoginProgress): void {
    this.loginProgress.set(progress.loginId, progress);
    for (const subscriber of this.subscribers) subscriber({ ...progress });
  }
}
