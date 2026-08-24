import TelegramBot from "node-telegram-bot-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatService } from "../../runner/chatService.js";
import type { SessionStore } from "../../memory/sessionStore.js";
import type { RunStore } from "../../runs/runStore.js";
import type { ChannelAdapter } from "../types.js";
import { ChannelSessionStore } from "./channelSessionStore.js";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 600_000; // 10 min max
const WORKING_ON_IT_DELAY_MS = 8_000;
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1_000; // 15 min
const INLINE_TEXT_MAX_CHARS = 3_800; // Telegram message limit is 4096
const TELEGRAM_INGRESS_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const TELEGRAM_INGRESS_DEDUPE_MAX_ENTRIES = 1_000;

const HELP_TEXT = `
Alfred commands:

/help — show this message
/status — current session ID, label, and start time
/label <text> — set a context hint for this chat (e.g. /label lead gen — MSPs USA)
/label — clear the label
/newsession — start a fresh session (clears Alfred's context for this chat)

Any other message is sent to Alfred as a task.
`.trim();

interface TelegramIngressDeduperOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Bounded in-memory sliding-window dedupe for Telegram polling redeliveries. */
export class TelegramIngressDeduper {
  private readonly entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TelegramIngressDeduperOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? TELEGRAM_INGRESS_DEDUPE_MAX_ENTRIES);
    this.ttlMs = Math.max(1, options.ttlMs ?? TELEGRAM_INGRESS_DEDUPE_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  hasSeen(key: string): boolean {
    const now = this.now();
    this.prune(now);

    const seenAt = this.entries.get(key);
    if (seenAt !== undefined) {
      // Refresh the insertion order and TTL so repeated polling retries stay
      // suppressed without allowing the cache to grow beyond its bound.
      this.entries.delete(key);
      this.entries.set(key, now);
      return true;
    }

    this.entries.set(key, now);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return false;
  }

  private prune(now: number): void {
    for (const [key, seenAt] of this.entries) {
      if (now - seenAt >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }
}

type TelegramMessageWithOptionalUpdateId = TelegramBot.Message & { update_id?: number };

export function telegramIngressKey(message: TelegramMessageWithOptionalUpdateId): string | undefined {
  if (typeof message.update_id === "number") {
    return `update:${message.update_id}`;
  }
  if (typeof message.chat?.id !== "number" || typeof message.message_id !== "number") {
    return undefined;
  }
  return `message:${message.chat.id}:${message.message_id}`;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram";

  private readonly bot: TelegramBot;
  private readonly channelStore: ChannelSessionStore;
  private readonly ingressDeduper = new TelegramIngressDeduper();
  private readonly activeChatTurns = new Map<number, number>();
  private readonly outboundTails = new Map<number, Promise<void>>();
  // chatId → "awaiting_confirm" when /newsession was issued
  private readonly pendingConfirm = new Map<number, true>();

  constructor(
    private readonly token: string,
    private readonly chatService: ChatService,
    private readonly sessionStore: SessionStore,
    private readonly runStore: RunStore,
    private readonly workspaceDir: string,
    private readonly allowedUserIds: number[] = [],
    bot?: TelegramBot
  ) {
    this.bot = bot ?? new TelegramBot(token, { polling: true });
    this.channelStore = new ChannelSessionStore(workspaceDir);
  }

  async start(): Promise<void> {
    this.bot.on("message", (msg) => {
      const key = telegramIngressKey(msg as TelegramMessageWithOptionalUpdateId);
      if (key && this.ingressDeduper.hasSeen(key)) {
        console.debug(`[telegram] ignored duplicate ingress update (${key})`);
        return;
      }
      void this.handleMessage(msg).catch((error) => {
        console.error("[telegram] unhandled error:", error);
      });
    });
    console.log("[telegram] adapter started (polling)");
  }

  // ─── session helpers ───────────────────────────────────────────────────────

  private channelKey(chatId: number): string {
    return `telegram:${chatId}`;
  }

  private async getOrCreateSessionId(chatId: number): Promise<string> {
    const key = this.channelKey(chatId);
    const existing = await this.channelStore.get(key);
    if (existing) {
      return existing.sessionId;
    }

    const session = await this.sessionStore.createSession(`Telegram chat ${chatId}`);
    await this.channelStore.set(key, {
      sessionId: session.id,
      label: null,
      createdAt: new Date().toISOString()
    });
    return session.id;
  }

  // ─── message dispatch ──────────────────────────────────────────────────────

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    // Fail closed: an empty allowlist denies everyone rather than serving all users.
    if (this.allowedUserIds.length === 0 || !userId || !this.allowedUserIds.includes(userId)) {
      await this.send(chatId, "Unauthorized.");
      return;
    }

    const text = msg.text?.trim();
    if (!text) return;

    // /newsession confirmation flow
    if (this.pendingConfirm.has(chatId)) {
      this.pendingConfirm.delete(chatId);
      const lower = text.toLowerCase();
      if (lower === "yes" || lower === "y") {
        await this.doNewSession(chatId);
      } else {
        await this.send(chatId, "Cancelled — continuing with the current session.");
      }
      return;
    }

    if (text.startsWith("/help")) {
      await this.send(chatId, HELP_TEXT);
      return;
    }

    if (text.startsWith("/newsession")) {
      await this.handleNewSessionCommand(chatId);
      return;
    }

    if (text.startsWith("/label")) {
      await this.handleLabelCommand(chatId, text);
      return;
    }

    if (text.startsWith("/status")) {
      await this.handleStatusCommand(chatId);
      return;
    }

    // Normal message — run Alfred
    await this.handleRun(chatId, text, String(userId));
  }

  // ─── commands ─────────────────────────────────────────────────────────────

  private async handleNewSessionCommand(chatId: number): Promise<void> {
    this.pendingConfirm.set(chatId, true);
    const record = await this.channelStore.get(this.channelKey(chatId));
    const label = record?.label ? ` (${record.label})` : "";
    await this.send(
      chatId,
      `Start a new session${label}? This will clear Alfred's current context for this chat.\n\nReply yes to confirm, anything else to cancel.`
    );
  }

  private async doNewSession(chatId: number): Promise<void> {
    const session = await this.sessionStore.createSession(`Telegram chat ${chatId}`);
    await this.channelStore.resetSession(this.channelKey(chatId), session.id);
    const record = await this.channelStore.get(this.channelKey(chatId));
    const label = record?.label ? ` Label kept: ${record.label}.` : "";
    await this.send(chatId, `New session started.${label} Alfred has a clean slate for this chat.`);
  }

  private async handleLabelCommand(chatId: number, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const label = parts.slice(1).join(" ").trim() || null;

    // Ensure a session record exists first
    await this.getOrCreateSessionId(chatId);
    await this.channelStore.setLabel(this.channelKey(chatId), label);

    if (label) {
      await this.send(chatId, `Label set to "${label}". I'll orient toward that context in this chat.`);
    } else {
      await this.send(chatId, "Label cleared. This chat is now general-purpose.");
    }
  }

  private async handleStatusCommand(chatId: number): Promise<void> {
    const record = await this.channelStore.get(this.channelKey(chatId));
    if (!record) {
      await this.send(chatId, "No session yet — send a message to start one.");
      return;
    }

    const lines = [
      `Session: ${record.sessionId}`,
      `Label: ${record.label ?? "none"}`,
      `Started: ${record.createdAt}`
    ];
    await this.send(chatId, lines.join("\n"));
  }

  // ─── run execution ─────────────────────────────────────────────────────────

  private async handleRun(chatId: number, text: string, principalId: string): Promise<void> {
    // Reserve the final-response slot before any await. This preserves ingress
    // order even when a later run completes/polls before an earlier one has
    // finished its Telegram API calls.
    const deliverOutbound = this.reserveOutboundDelivery(chatId);
    const activeTurnCount = this.activeChatTurns.get(chatId) ?? 0;
    const wasBusy = activeTurnCount > 0;
    this.activeChatTurns.set(chatId, activeTurnCount + 1);
    if (wasBusy) {
      void this.sendTypingAction(chatId);
    }

    let deliveryStarted = false;
    let workingTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let progressMsgId: number | null = null;
    let lastStatus = "Working on it...";

    const cleanupProgress = (): void => {
      if (workingTimer) clearTimeout(workingTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      unsubscribe?.();
    };

    try {
      const sessionId = await this.getOrCreateSessionId(chatId);
      const record = await this.channelStore.get(this.channelKey(chatId));

      // Prepend channel label context so Alfred knows which mode it's in
      const message = record?.label
        ? `[Channel context: ${record.label}]\n\n${text}`
        : text;

      // Submit as async job — returns runId immediately. Any queued feedback
      // above is transport-only and never enters ChatService/session memory.
      const result = await this.chatService.handleTurn({
        sessionId,
        message,
        requestJob: true,
        channelKey: this.channelKey(chatId),
        principalId,
        origin: "telegram"
      });

      const runId = result.runId;
      const editProgress = async (statusText: string) => {
        lastStatus = statusText;
        if (progressMsgId !== null) {
          await this.bot.editMessageText(statusText, { chat_id: chatId, message_id: progressMsgId }).catch(() => {});
        }
      };

      // Send initial "Working on it..." after delay, then subscribe to events for live updates
      const startedAt = Date.now();
      workingTimer = setTimeout(async () => {
        try {
          const msg = await this.bot.sendMessage(chatId, lastStatus);
          progressMsgId = msg.message_id;
        } catch { /* non-fatal */ }
      }, WORKING_ON_IT_DELAY_MS);

      unsubscribe = this.runStore.subscribeToRun(runId, (event) => {
        const line = distillProgressLine(event);
        if (line) void editProgress(line);
      });

      // Heartbeat — edit the progress message rather than sending a new one
      heartbeatTimer = setInterval(() => {
        const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
        void editProgress(`${lastStatus} _(${elapsedMin}m)_`);
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      const run = await this.pollUntilDone(runId);
      deliveryStarted = true;
      await deliverOutbound(async () => {
        cleanupProgress();
        try {
          const responseText = run?.assistantText ?? "Done — no response text.";
          await this.sendResponse(chatId, responseText);

          // Deliver artifacts after the answer and before the next queued
          // turn's final response is released.
          if (run?.artifactPaths?.length) {
            for (const artifactPath of run.artifactPaths) {
              await this.deliverArtifact(chatId, artifactPath);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown delivery error";
          await this.send(chatId, `Something went wrong delivering the result: ${message}`).catch(() => {});
        }
      });
    } catch (error) {
      cleanupProgress();
      if (!deliveryStarted) {
        deliveryStarted = true;
        const message = error instanceof Error ? error.message : "Unknown error";
        await deliverOutbound(async () => {
          await this.send(chatId, `Something went wrong: ${message}`).catch(() => {});
        });
      } else {
        console.error("[telegram] outbound delivery failed:", error);
      }
    } finally {
      cleanupProgress();
      const remainingTurns = (this.activeChatTurns.get(chatId) ?? 1) - 1;
      if (remainingTurns > 0) {
        this.activeChatTurns.set(chatId, remainingTurns);
      } else {
        this.activeChatTurns.delete(chatId);
      }
    }
  }

  private reserveOutboundDelivery(chatId: number): (task: () => Promise<void>) => Promise<void> {
    const previous = this.outboundTails.get(chatId) ?? Promise.resolve();
    let releaseNext!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    this.outboundTails.set(chatId, current);

    let used = false;
    return async (task: () => Promise<void>): Promise<void> => {
      if (used) {
        throw new Error("Telegram outbound reservation already used");
      }
      used = true;
      // A failed earlier delivery must not strand every later reservation.
      await previous.catch(() => undefined);
      try {
        await task();
      } finally {
        releaseNext();
        if (this.outboundTails.get(chatId) === current) {
          this.outboundTails.delete(chatId);
        }
      }
    };
  }

  private async sendTypingAction(chatId: number): Promise<void> {
    await this.bot.sendChatAction(chatId, "typing").catch(() => {});
  }

  private async pollUntilDone(runId: string): Promise<Awaited<ReturnType<RunStore["getRun"]>>> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const run = await this.runStore.getRun(runId);
      if (run && run.status !== "running" && run.status !== "queued") {
        return run;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error("Run timed out after 10 minutes.");
  }

  // ─── response delivery ────────────────────────────────────────────────────

  private async sendResponse(chatId: number, text: string): Promise<void> {
    if (text.length <= INLINE_TEXT_MAX_CHARS) {
      await this.send(chatId, text);
      return;
    }

    // Split into chunks at paragraph boundaries
    const chunks = splitIntoChunks(text, INLINE_TEXT_MAX_CHARS);
    for (const chunk of chunks) {
      await this.send(chatId, chunk);
    }
  }

  private async deliverArtifact(chatId: number, artifactPath: string): Promise<void> {
    // Tools store artifact paths project-relative (see addArtifact callers), and
    // ToolContext.projectRoot is process.cwd() — resolve against that, not the
    // workspace dir, which would double the path (workspace/alfred/workspace/...).
    const fullPath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.resolve(process.cwd(), artifactPath);

    let content: Buffer;
    try {
      content = await readFile(fullPath);
    } catch {
      await this.send(chatId, `Artifact not found: ${artifactPath}`);
      return;
    }

    const filename = path.basename(fullPath);
    const isText = /\.(md|txt|csv|json|yaml|yml|html)$/i.test(filename);

    if (isText) {
      const text = content.toString("utf8");
      if (text.length <= INLINE_TEXT_MAX_CHARS) {
        await this.send(chatId, `\`\`\`\n${text}\n\`\`\``);
        return;
      }
    }

    await this.bot.sendDocument(chatId, content, {}, {
      filename,
      contentType: "application/octet-stream"
    });
  }

  private async send(chatId: number, text: string): Promise<void> {
    await this.bot.sendMessage(chatId, text, { parse_mode: "Markdown" }).catch(async () => {
      // Markdown parse errors — retry as plain text
      await this.bot.sendMessage(chatId, text);
    });
  }
}

// ─── Progress line formatter ──────────────────────────────────────────────────
// Maps run events to a short human-readable status line for Telegram edit-in-place.
// Returns null for events not worth surfacing.

function distillProgressLine(event: import("../../types.js").RunEvent): string | null {
  const p = (event.payload ?? {}) as Record<string, unknown>;

  if (event.phase === "tool" && event.eventType === "tool_action_started") {
    const tool = String(p.toolName ?? "");
    const detail = extractToolDetail(tool, p.inputJson as string | undefined);
    return detail ? `⚙️ ${tool} › ${detail}` : `⚙️ ${tool}...`;
  }

  if (event.phase === "tool" && event.eventType === "tool_progress") {
    const message = String(p.message ?? "");
    const tool = String(p.toolName ?? "tool");
    return message ? `⚙️ ${tool} › ${message}` : null;
  }

  if (event.phase === "tool" && event.eventType === "tool_action_failed") {
    const tool = String(p.toolName ?? "tool");
    const err = String(p.error ?? "failed").slice(0, 80);
    return `❌ ${tool} failed — ${err}`;
  }

  if (event.phase === "thought" && event.eventType === "model_response") {
    const text = String(p.text ?? p.content ?? "").trim().slice(0, 120);
    return text ? `💭 ${text}` : null;
  }

  return null;
}

function extractToolDetail(toolName: string, inputJson: string | undefined): string | null {
  if (!inputJson) return null;
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    switch (toolName) {
      case "file_read":
      case "file_write":
      case "file_edit":
        return String(input.path ?? "").replace(/^workspace\/alfred\//, "");
      case "web_fetch":
        return truncateUrl(String(input.url ?? ""), 60);
      case "search":
        return `"${String(input.query ?? "").slice(0, 60)}"`;
      case "shell_exec":
        return String(input.command ?? "").slice(0, 60);
      case "lead_extractor":
        return truncateUrl(String(input.url ?? ""), 60);
      case "lead_generation":
        return String(input.query ?? "").slice(0, 60);
      case "code_discover":
        return `"${String(input.pattern ?? "").slice(0, 40)}"`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function truncateUrl(url: string, max: number): string {
  try {
    const { hostname, pathname } = new URL(url);
    const short = `${hostname}${pathname}`.replace(/\/$/, "");
    return short.length > max ? short.slice(0, max) + "…" : short;
  } catch {
    return url.slice(0, max);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitIntoChunks(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = para.slice(0, maxLen);
    } else {
      current = candidate.slice(0, maxLen);
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
