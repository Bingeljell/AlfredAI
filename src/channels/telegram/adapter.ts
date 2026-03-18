import TelegramBot from "node-telegram-bot-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatService } from "../../services/chatService.js";
import type { SessionStore } from "../../memory/sessionStore.js";
import type { RunStore } from "../../runs/runStore.js";
import type { ChannelAdapter } from "../types.js";
import { ChannelSessionStore } from "./channelSessionStore.js";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 600_000; // 10 min max
const WORKING_ON_IT_DELAY_MS = 8_000;
const INLINE_TEXT_MAX_CHARS = 3_800; // Telegram message limit is 4096

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram";

  private readonly bot: TelegramBot;
  private readonly channelStore: ChannelSessionStore;
  // chatId → "awaiting_confirm" when /newsession was issued
  private readonly pendingConfirm = new Map<number, true>();

  constructor(
    private readonly token: string,
    private readonly chatService: ChatService,
    private readonly sessionStore: SessionStore,
    private readonly runStore: RunStore,
    private readonly workspaceDir: string
  ) {
    this.bot = new TelegramBot(token, { polling: true });
    this.channelStore = new ChannelSessionStore(workspaceDir);
  }

  async start(): Promise<void> {
    this.bot.on("message", (msg) => {
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
    await this.handleRun(chatId, text);
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

  private async handleRun(chatId: number, text: string): Promise<void> {
    const sessionId = await this.getOrCreateSessionId(chatId);
    const record = await this.channelStore.get(this.channelKey(chatId));

    // Prepend channel label context so Alfred knows which mode it's in
    const message = record?.label
      ? `[Channel context: ${record.label}]\n\n${text}`
      : text;

    // Submit as async job — returns runId immediately
    const result = await this.chatService.handleTurn({
      sessionId,
      message,
      requestJob: true
    });

    const runId = result.runId;

    // Send "Working on it..." after WORKING_ON_IT_DELAY_MS if still running
    const workingTimer = setTimeout(() => {
      void this.send(chatId, "Working on it...");
    }, WORKING_ON_IT_DELAY_MS);

    try {
      const run = await this.pollUntilDone(runId);
      clearTimeout(workingTimer);

      const responseText = run?.assistantText ?? "Done — no response text.";
      await this.sendResponse(chatId, responseText);

      // Deliver artifacts
      if (run?.artifactPaths?.length) {
        for (const artifactPath of run.artifactPaths) {
          await this.deliverArtifact(chatId, artifactPath);
        }
      }
    } catch (error) {
      clearTimeout(workingTimer);
      const msg = error instanceof Error ? error.message : "Unknown error";
      await this.send(chatId, `Something went wrong: ${msg}`);
    }
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
    const fullPath = path.isAbsolute(artifactPath)
      ? artifactPath
      : path.join(this.workspaceDir, artifactPath);

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
