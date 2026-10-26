import type { BotConfig } from '../types/config.js';
import type { MessageCreateData } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import { DISCORD_GATEWAY } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('AutoReply');

export class AutoReplyService {
  private readonly config: BotConfig;
  private readonly cache?: EntityCache;
  private readonly activeTimers: Set<NodeJS.Timeout> = new Set();

  constructor(config: BotConfig, cache?: EntityCache) {
    this.config = config;
    this.cache = cache;
  }

  public handleMessage(message: MessageCreateData, botUserId: string | null): void {
    if (!this.config.autoReply.enabled || !botUserId) {
      return;
    }

    // Ignore messages from the bot itself
    if (message.author.id === botUserId) {
      return;
    }

    // Check if the bot is mentioned
    const isMentioned = message.mentions.some((m) => m.id === botUserId);
    if (!isMentioned) {
      return;
    }

    const content = (message.content || '').toLowerCase();
    if (!content.includes(this.config.autoReply.trigger)) {
      return;
    }

    logger.info(
      `Triggered by ${message.author.username}. Replying in ${this.config.autoReply.delaySeconds}s...`
    );

    this.sendDelayedReply(message.channel_id);
  }

  private sendDelayedReply(channelId: string): void {
    const delayMs = Math.max(0, this.config.autoReply.delaySeconds * 1000);
    const typingDurationMs = Math.min(2000, Math.max(1000, Math.floor(delayMs / 2)));
    const preTypingDelayMs = Math.max(0, delayMs - typingDurationMs);

    const timer = setTimeout(async () => {
      this.activeTimers.delete(timer);
      try {
        await this.sendTypingIndicator(channelId);
        await new Promise((resolve) => setTimeout(resolve, typingDurationMs));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: this.config.token,
            'Content-Type': 'application/json',
            'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
          },
          body: JSON.stringify({
            content: this.config.autoReply.message,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const channelName = this.cache?.getChannelName(channelId) ?? channelId;
        if (response.ok) {
          logger.success(`Reply sent to ${channelName}`);
        } else {
          logger.warn(`Reply failed with HTTP status ${response.status}`);
        }
      } catch (error) {
        logger.error(`Reply failed: ${(error as Error).message}`);
      }
    }, preTypingDelayMs);

    this.activeTimers.add(timer);
  }

  private async sendTypingIndicator(channelId: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/typing`, {
        method: 'POST',
        headers: {
          Authorization: this.config.token,
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch {
      // Typing indicator failure is non-fatal
    }
  }

  public destroy(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
  }
}
