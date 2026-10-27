import type { BotConfig } from '../types/config.js';
import type { MessageCreateData } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import type { DiscordApiClient } from '../api/discord-client.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('AutoReply');

const USER_COOLDOWN_MS = 60 * 1000; // 60 seconds per user to prevent mention-spam attacks

export class AutoReplyService {
  private readonly config: BotConfig;
  private readonly apiClient: DiscordApiClient;
  private readonly cache?: EntityCache;
  private readonly activeTimers: Set<NodeJS.Timeout> = new Set();
  private readonly pendingReplyChannels: Set<string> = new Set();
  private readonly userCooldowns: Map<string, number> = new Map();

  constructor(config: BotConfig, apiClient: DiscordApiClient, cache?: EntityCache) {
    this.config = config;
    this.apiClient = apiClient;
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

    // Per-user cooldown: prevent a malicious user from spamming mentions to flag the account
    const now = Date.now();
    const userLastTrigger = this.userCooldowns.get(message.author.id) || 0;
    if (now - userLastTrigger < USER_COOLDOWN_MS) {
      logger.debug(
        `User ${message.author.username} (${message.author.id}) on cooldown. Ignoring trigger.`
      );
      return;
    }

    // Debounce: ignore burst mentions if a reply is already pending for this channel
    if (this.pendingReplyChannels.has(message.channel_id)) {
      logger.debug(`Reply already pending for channel ${message.channel_id}. Debounced.`);
      return;
    }

    this.userCooldowns.set(message.author.id, now);

    // Calculate humanized delay: base delay with ±25% natural variation
    const baseDelaySec = Math.max(3, this.config.autoReply.delaySeconds);
    const jitterSec = (Math.random() * 0.5 - 0.25) * baseDelaySec;
    const finalDelaySec = Math.max(2, baseDelaySec + jitterSec);

    logger.info(
      `Triggered by ${message.author.username}. Replying in ${finalDelaySec.toFixed(1)}s...`
    );

    this.sendDelayedReply(message.channel_id, finalDelaySec);
  }

  private sendDelayedReply(channelId: string, delaySec: number): void {
    this.pendingReplyChannels.add(channelId);

    const replyText = this.config.autoReply.message;
    // Human typing simulation: ~100-150ms per character + initial reading hesitation
    const simulatedTypingMs = Math.min(
      4500,
      Math.max(1200, replyText.length * 120 + Math.floor(Math.random() * 600))
    );

    const totalDelayMs = Math.max(simulatedTypingMs + 500, Math.floor(delaySec * 1000));
    const preTypingDelayMs = Math.max(500, totalDelayMs - simulatedTypingMs);

    const timer = setTimeout(async () => {
      this.activeTimers.delete(timer);
      try {
        await this.apiClient.sendTyping(channelId);
        await new Promise((resolve) => setTimeout(resolve, simulatedTypingMs));

        const success = await this.apiClient.sendMessage(channelId, replyText);

        const channelName = this.cache?.getChannelName(channelId) ?? channelId;
        if (success) {
          logger.success(`Reply sent to #${channelName}`);
        } else {
          logger.warn(`Reply failed for #${channelName}`);
        }
      } catch (error) {
        logger.error(`Reply failed: ${(error as Error).message}`);
      } finally {
        this.pendingReplyChannels.delete(channelId);
      }
    }, preTypingDelayMs);

    this.activeTimers.add(timer);
  }

  public destroy(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.pendingReplyChannels.clear();
    this.userCooldowns.clear();
  }
}
