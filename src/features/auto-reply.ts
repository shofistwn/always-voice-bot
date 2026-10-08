import EventEmitter from 'node:events';
import type { BotConfig } from '../types/config.js';
import type { MessageCreateData } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import { DISCORD_GATEWAY } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('AutoReply');

export class AutoReplyService extends EventEmitter {
  private readonly config: BotConfig;
  private readonly cache?: EntityCache;
  private readonly activeTimers: Set<NodeJS.Timeout> = new Set();

  constructor(config: BotConfig, cache?: EntityCache) {
    super();
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

    this.emit('trigger', message);
    this.sendDelayedReply(message.channel_id);
  }

  private sendDelayedReply(channelId: string): void {
    const delayMs = this.config.autoReply.delaySeconds * 1000;

    const timer = setTimeout(async () => {
      this.activeTimers.delete(timer);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

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
    }, delayMs);

    this.activeTimers.add(timer);
  }

  public destroy(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.removeAllListeners();
  }
}
