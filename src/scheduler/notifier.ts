import TelegramBot from "node-telegram-bot-api";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NotificationDestination } from "./types.js";
import { redactValue } from "../utils/redact.js";

export type SchedulerOrigin = "web" | "telegram" | "scheduler";

export interface SchedulerProvenance {
  principalId: string;
  channelKey?: string;
  origin: SchedulerOrigin;
}

export interface OutboundNotification {
  destination: NotificationDestination;
  text: string;
  deliveryId: string;
}

export interface OutboundNotificationResult {
  delivered: boolean;
  externalMessageId?: string;
}

export interface OutboundNotifier {
  send(notification: OutboundNotification): Promise<OutboundNotificationResult>;
}

export interface TelegramDestinationValidator {
  isAllowed(destination: NotificationDestination): Promise<boolean>;
}

export class TelegramOutboundNotifier implements OutboundNotifier {
  private readonly bot: TelegramBot;

  constructor(
    token: string,
    private readonly validator: TelegramDestinationValidator,
  ) {
    this.bot = new TelegramBot(token);
  }

  async send(notification: OutboundNotification): Promise<OutboundNotificationResult> {
    if (!notification.destination.channelKey.startsWith("telegram:")) {
      throw new Error("unsupported_notification_destination");
    }
    if (!await this.validator.isAllowed(notification.destination)) {
      throw new Error("notification_destination_not_allowed");
    }
    const chatIdText = notification.destination.channelKey.slice("telegram:".length);
    if (!/^-?\d+$/.test(chatIdText)) throw new Error("invalid_telegram_destination");
    const chatId = Number(chatIdText);
    if (!Number.isSafeInteger(chatId)) throw new Error("invalid_telegram_destination");
    try {
      const sent = await this.bot.sendMessage(chatId, notification.text, { parse_mode: "Markdown" });
      return { delivered: true, externalMessageId: String(sent.message_id) };
    } catch {
      const sent = await this.bot.sendMessage(chatId, notification.text);
      return { delivered: true, externalMessageId: String(sent.message_id) };
    }
  }
}

export interface WebActivitySink {
  append(item: { principalId: string; channelKey: string; text: string; deliveryId: string }): Promise<void>;
}

export class WebOutboundNotifier implements OutboundNotifier {
  constructor(private readonly sink: WebActivitySink) {}

  async send(notification: OutboundNotification): Promise<OutboundNotificationResult> {
    if (!notification.destination.channelKey.startsWith("web:")) throw new Error("unsupported_notification_destination");
    await this.sink.append({
      principalId: notification.destination.principalId,
      channelKey: notification.destination.channelKey,
      text: notification.text,
      deliveryId: notification.deliveryId,
    });
    return { delivered: true };
  }
}

export class FileWebActivitySink implements WebActivitySink {
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, "scheduler", "web-activity.jsonl");
  }

  async append(item: { principalId: string; channelKey: string; text: string; deliveryId: string }): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, `${JSON.stringify(redactValue({ ...item, timestamp: new Date().toISOString() }))}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export class RoutingOutboundNotifier implements OutboundNotifier {
  constructor(
    private readonly web: OutboundNotifier,
    private readonly telegram?: OutboundNotifier,
  ) {}

  async send(notification: OutboundNotification): Promise<OutboundNotificationResult> {
    if (notification.destination.channelKey.startsWith("telegram:")) {
      if (!this.telegram) throw new Error("telegram_notification_unavailable");
      return this.telegram.send(notification);
    }
    if (notification.destination.channelKey.startsWith("web:")) return this.web.send(notification);
    throw new Error("unsupported_notification_destination");
  }
}

export class ConsoleOutboundNotifier implements OutboundNotifier {
  async send(notification: OutboundNotification): Promise<OutboundNotificationResult> {
    console.log(`[scheduler:${notification.deliveryId}] ${notification.text}`);
    return { delivered: true };
  }
}
