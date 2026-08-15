/**
 * agentEvents/notifier — outbound notification for agent events.
 *
 * The dispatcher depends only on the `AgentEventNotifier` interface, so it can
 * be unit-tested with a fake and swapped at runtime:
 *   - TelegramAgentEventNotifier: proactive push via the Bot API (REST only,
 *     no polling — safe to run alongside the polling TelegramAdapter).
 *   - ConsoleAgentEventNotifier: logs the notification; used when Telegram is
 *     not configured so events are never silently dropped.
 */

import TelegramBot from "node-telegram-bot-api";

export interface AgentEventNotifier {
  send(text: string): Promise<void>;
}

export class ConsoleAgentEventNotifier implements AgentEventNotifier {
  async send(text: string): Promise<void> {
    console.log(`[agent-events] notification:\n${text}`);
  }
}

export class TelegramAgentEventNotifier implements AgentEventNotifier {
  private readonly bot: TelegramBot;

  constructor(
    token: string,
    private readonly chatId: number
  ) {
    this.bot = new TelegramBot(token);
  }

  async send(text: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, text, { parse_mode: "Markdown" });
    } catch {
      // Markdown parse failures (unbalanced backticks etc.) — retry as plain text.
      await this.bot.sendMessage(this.chatId, text);
    }
  }
}
