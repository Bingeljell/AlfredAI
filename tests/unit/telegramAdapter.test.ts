import test from "node:test";
import assert from "node:assert/strict";
import type TelegramBot from "node-telegram-bot-api";
import { TelegramAdapter, TelegramIngressDeduper, telegramIngressKey } from "../../src/channels/telegram/adapter.js";
import type { ChatService } from "../../src/runner/chatService.js";
import { SessionStore } from "../../src/memory/sessionStore.js";
import type { RunStore } from "../../src/runs/runStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

class FakeTelegramBot {
  private messageListener?: (message: TelegramBot.Message, metadata: TelegramBot.Metadata) => void;
  private nextMessageId = 100;

  on(_event: string, listener: (message: TelegramBot.Message, metadata: TelegramBot.Metadata) => void): this {
    this.messageListener = listener;
    return this;
  }

  emit(message: TelegramBot.Message): void {
    this.messageListener?.(message, {});
  }

  async sendMessage(..._args: unknown[]): Promise<{ message_id: number }> {
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(..._args: unknown[]): Promise<boolean> {
    return true;
  }

  async sendDocument(..._args: unknown[]): Promise<boolean> {
    return true;
  }

  async sendChatAction(..._args: unknown[]): Promise<boolean> {
    return true;
  }
}

test("Telegram ingress deduper drops a re-polled message ID within its TTL", () => {
  let now = 1_000;
  const deduper = new TelegramIngressDeduper({
    ttlMs: 300,
    maxEntries: 100,
    now: () => now
  });
  const message = {
    chat: { id: 42 },
    message_id: 17
  } as never;
  const key = telegramIngressKey(message);

  assert.equal(key, "message:42:17");
  assert.equal(deduper.hasSeen(key!), false);
  assert.equal(deduper.hasSeen(key!), true);

  now += 301;
  assert.equal(deduper.hasSeen(key!), false);
});

test("Telegram ingress deduper supports update IDs and stays bounded", () => {
  let now = 1_000;
  const deduper = new TelegramIngressDeduper({
    ttlMs: 10_000,
    maxEntries: 2,
    now: () => now
  });
  const update = {
    update_id: 9001,
    chat: { id: 42 },
    message_id: 17
  } as never;

  assert.equal(telegramIngressKey(update), "update:9001");
  assert.equal(deduper.hasSeen("message:42:1"), false);
  assert.equal(deduper.hasSeen("message:42:2"), false);
  assert.equal(deduper.hasSeen("message:42:3"), false);
  assert.equal(deduper.hasSeen("message:42:1"), false);
  assert.equal(deduper.hasSeen("update:9001"), false);
  assert.equal(deduper.hasSeen("update:9001"), true);

  now += 10_001;
  assert.equal(deduper.hasSeen("update:9001"), false);
});

test("Telegram adapter drops duplicate message events before ChatService", async () => {
  const workspace = await createTempWorkspace("telegram-ingress-dedupe");
  const sessionStore = new SessionStore(workspace);
  let resolveHandled!: () => void;
  const handled = new Promise<void>((resolve) => {
    resolveHandled = resolve;
  });
  let calls = 0;
  const fakeChatService = {
    handleTurn: async () => {
      calls += 1;
      resolveHandled();
      return { runId: "run-1", status: "queued" };
    }
  };
  const fakeRunStore = {
    getRun: async () => ({ status: "completed", assistantText: "done" }),
    subscribeToRun: () => () => {}
  };
  const bot = new FakeTelegramBot();
  const adapter = new TelegramAdapter(
    "test-token",
    fakeChatService as unknown as ChatService,
    sessionStore,
    fakeRunStore as unknown as RunStore,
    workspace,
    [7],
    bot as unknown as TelegramBot
  );

  await adapter.start();
  const message = {
    message_id: 17,
    date: Math.floor(Date.now() / 1_000),
    chat: { id: 42, type: "private" },
    from: { id: 7, is_bot: false, first_name: "Nikhil" },
    text: "hello"
  } as TelegramBot.Message;
  bot.emit(message);
  bot.emit(message);

  await handled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
