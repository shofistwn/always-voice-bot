import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig } from '../types/config.js';
import type { MessageCreateData } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import { DISCORD_GATEWAY } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('OwOAssist');

const OWO_BOT_USER_ID = '408785106942164992';
const PRAY_CURSE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export type QuestAction = 'pray' | 'curse' | 'cookie';

export interface OwOQueueItem {
  id: string; // unique per target user & action: `${userId}:${action}`
  userId: string;
  channelId: string;
  action: QuestAction;
  remainingCount: number;
  nextRun: number; // Unix timestamp ms
}

interface OwOPersistedState {
  globalNextPrayCurseRun: number;
  items: OwOQueueItem[];
}

export class OwoAssistantService {
  private readonly config: BotConfig;
  private readonly cache?: EntityCache;
  private readonly filePath: string;

  private queue: Map<string, OwOQueueItem> = new Map();
  private scheduledTimers: Map<string, NodeJS.Timeout> = new Map();
  private globalNextPrayCurseRun: number = 0;
  private isProcessing: boolean = false;
  private isBattlePending: boolean = false;
  private isSaveQueued: boolean = false;
  private isSaving: boolean = false;
  private isDestroyed: boolean = false;

  constructor(config: BotConfig, cache?: EntityCache) {
    this.config = config;
    this.cache = cache;
    this.filePath = path.resolve(process.cwd(), 'owo-queue.json');

    if (this.config.owoAssistant.enabled) {
      this.loadQueueFromFile();
    }
  }

  public start(): void {
    if (!this.config.owoAssistant.enabled) return;
    this.schedulePendingItems();
  }

  public handleMessage(message: MessageCreateData, botUserId: string | null): void {
    if (!this.config.owoAssistant.enabled || !botUserId) {
      return;
    }

    if (message.author.id === botUserId) {
      return;
    }

    if (message.author.id === OWO_BOT_USER_ID) {
      this.handleOwOBotMessage(message, botUserId);
      return;
    }

    if (this.config.owoAssistant.channelId && message.channel_id !== this.config.owoAssistant.channelId) {
      return;
    }

    const isMentioned = message.mentions.some((m) => m.id === botUserId);
    if (!isMentioned) {
      return;
    }

    this.handleUserMention(message);
  }

  private handleOwOBotMessage(message: MessageCreateData, botUserId: string): void {
    const content = message.content || '';
    const mentionsBot = message.mentions.some((m) => m.id === botUserId) || content.includes(botUserId);
    const isBattleChallenge = content.toLowerCase().includes('owoab') &&
      (content.toLowerCase().includes('battle') || content.toLowerCase().includes('challenge'));

    if (mentionsBot && isBattleChallenge && !this.isBattlePending) {
      this.isBattlePending = true;
      logger.info('Battle challenge detected! Auto-accepting in 1.5–3s...');
      const delay = Math.floor(Math.random() * 1500) + 1500;

      setTimeout(async () => {
        try {
          if (this.isDestroyed) return;
          await this.sendTypingIndicator(message.channel_id);
          await this.sendMessage(message.channel_id, 'owoab');
          logger.success('Sent owoab to accept battle!');
        } finally {
          this.isBattlePending = false;
        }
      }, delay);
    }
  }

  private handleUserMention(message: MessageCreateData): void {
    const rawContent = (message.content || '').toLowerCase();
    const authorId = message.author.id;
    const channelId = message.channel_id;

    let action: QuestAction | null = null;
    if (rawContent.includes('cookie') || rawContent.includes('kue')) {
      action = 'cookie';
    } else if (rawContent.includes('pray')) {
      action = 'pray';
    } else if (rawContent.includes('curse')) {
      action = 'curse';
    }

    if (!action) {
      return;
    }

    const count = this.extractCount(rawContent);

    logger.info(
      `Received quest request from ${message.author.username}: action=${action}, count=${count}`
    );

    this.enqueueTask(authorId, channelId, action, count);
  }

  private extractCount(text: string): number {
    const matchSuffix = text.match(/(\d+)\s*(?:x|kali)\b/);
    if (matchSuffix && matchSuffix[1]) {
      const parsed = parseInt(matchSuffix[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) return Math.min(parsed, 100);
    }

    const matchPrefix = text.match(/\bx\s*(\d+)/);
    if (matchPrefix && matchPrefix[1]) {
      const parsed = parseInt(matchPrefix[1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) return Math.min(parsed, 100);
    }

    return 1;
  }

  private enqueueTask(userId: string, channelId: string, action: QuestAction, count: number): void {
    const queueKey = `${userId}:${action}`;
    const existing = this.queue.get(queueKey);

    if (existing) {
      existing.remainingCount += count;
      existing.channelId = channelId;
      this.saveQueueToFile();
      logger.info(
        `Accumulated quest queue for user ${userId}: action=${action}, new total=${existing.remainingCount}`
      );

      if (!this.scheduledTimers.has(queueKey)) {
        this.scheduleItem(existing);
      }
      return;
    }

    const now = Date.now();
    let initialRun = now;

    if (action === 'pray' || action === 'curse') {
      if (this.globalNextPrayCurseRun > now) {
        initialRun = this.globalNextPrayCurseRun;
      }
    }

    const newItem: OwOQueueItem = {
      id: queueKey,
      userId,
      channelId,
      action,
      remainingCount: count,
      nextRun: initialRun,
    };

    this.queue.set(queueKey, newItem);
    this.saveQueueToFile();
    this.scheduleItem(newItem);
  }

  private schedulePendingItems(): void {
    for (const item of this.queue.values()) {
      this.scheduleItem(item);
    }
  }

  private scheduleItem(item: OwOQueueItem): void {
    const existingTimer = this.scheduledTimers.get(item.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.scheduledTimers.delete(item.id);
    }

    if (item.remainingCount <= 0 || this.isDestroyed) {
      this.queue.delete(item.id);
      this.saveQueueToFile();
      return;
    }

    const now = Date.now();
    let targetRun = item.nextRun;

    if (item.action === 'pray' || item.action === 'curse') {
      if (this.globalNextPrayCurseRun > targetRun) {
        targetRun = this.globalNextPrayCurseRun;
        item.nextRun = targetRun;
      }
    }

    const rawDelay = targetRun - now;
    const delay = rawDelay <= 0 ? 0 : rawDelay;

    logger.info(
      `Scheduled ${item.action} for user ${item.userId} in ${(delay / 1000).toFixed(0)}s (remaining: ${item.remainingCount})`
    );

    const timer = setTimeout(() => {
      this.scheduledTimers.delete(item.id);
      void this.executeQueueItem(item.id);
    }, delay);

    this.scheduledTimers.set(item.id, timer);
  }

  private async executeQueueItem(itemId: string): Promise<void> {
    if (this.isDestroyed) return;

    if (this.isProcessing) {
      const retryDelay = Math.floor(Math.random() * 2000) + 2000;
      const retryTimer = setTimeout(() => {
        this.scheduledTimers.delete(itemId);
        void this.executeQueueItem(itemId);
      }, retryDelay);
      this.scheduledTimers.set(itemId, retryTimer);
      return;
    }

    this.isProcessing = true;

    try {
      const item = this.queue.get(itemId);
      if (!item || item.remainingCount <= 0) {
        this.queue.delete(itemId);
        this.saveQueueToFile();
        return;
      }

      const now = Date.now();
      if ((item.action === 'pray' || item.action === 'curse') && this.globalNextPrayCurseRun > now) {
        item.nextRun = this.globalNextPrayCurseRun;
        this.saveQueueToFile();
        this.scheduleItem(item);
        return;
      }

      await this.sendTypingIndicator(item.channelId);
      const typingWait = Math.floor(Math.random() * 1000) + 1500;
      await new Promise((resolve) => setTimeout(resolve, typingWait));

      const commandText = `owo ${item.action} <@${item.userId}>`;
      const success = await this.sendMessage(item.channelId, commandText);

      if (success) {
        item.remainingCount -= 1;
        const channelName = this.cache?.getChannelName(item.channelId) ?? item.channelId;
        logger.success(
          `Executed: "${commandText}" in #${channelName} (Remaining: ${item.remainingCount})`
        );

        const jitterMs = Math.floor(Math.random() * 10000) + 5000;

        if (item.action === 'pray' || item.action === 'curse') {
          this.globalNextPrayCurseRun = Date.now() + PRAY_CURSE_COOLDOWN_MS + jitterMs;
        }

        if (item.remainingCount <= 0) {
          logger.success(`Completed all ${item.action} requests for user ${item.userId}!`);
          this.queue.delete(itemId);
          this.saveQueueToFile();
        } else {
          const nextCooldown = item.action === 'cookie' ? 10000 + jitterMs : PRAY_CURSE_COOLDOWN_MS + jitterMs;
          item.nextRun = Date.now() + nextCooldown;
          this.saveQueueToFile();
          this.scheduleItem(item);
        }

        if (item.action === 'pray' || item.action === 'curse') {
          this.rescheduleConflictingPrayCurse(itemId);
        }
      } else {
        logger.warn(`Failed to send ${item.action}. Retrying in 15 seconds...`);
        item.nextRun = Date.now() + 15000;
        this.saveQueueToFile();
        this.scheduleItem(item);
      }
    } catch (err) {
      logger.error(`Error executing queue item ${itemId}: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private rescheduleConflictingPrayCurse(executedItemId: string): void {
    for (const [key, queuedItem] of this.queue.entries()) {
      if (key === executedItemId) continue;
      if (queuedItem.action === 'pray' || queuedItem.action === 'curse') {
        if (queuedItem.nextRun < this.globalNextPrayCurseRun) {
          queuedItem.nextRun = this.globalNextPrayCurseRun;
          this.scheduleItem(queuedItem);
        }
      }
    }
    this.saveQueueToFile();
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

  private async sendMessage(channelId: string, content: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: this.config.token,
          'Content-Type': 'application/json',
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      logger.error(`Failed to dispatch message to channel ${channelId}: ${(error as Error).message}`);
      return false;
    }
  }

  private loadQueueFromFile(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
      if (!raw) return;

      const parsed = JSON.parse(raw) as OwOQueueItem[] | OwOPersistedState;
      const now = Date.now();

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && item.id && item.remainingCount > 0) {
            if (!item.nextRun || typeof item.nextRun !== 'number') {
              item.nextRun = now;
            }
            this.queue.set(item.id, item);
          }
        }
      } else if (parsed && Array.isArray(parsed.items)) {
        this.globalNextPrayCurseRun = typeof parsed.globalNextPrayCurseRun === 'number' ? parsed.globalNextPrayCurseRun : 0;
        for (const item of parsed.items) {
          if (item && item.id && item.remainingCount > 0) {
            if (!item.nextRun || typeof item.nextRun !== 'number') {
              item.nextRun = now;
            }
            this.queue.set(item.id, item);
          }
        }
      }

      logger.info(`Loaded ${this.queue.size} pending OwO quest queue items from owo-queue.json`);
    } catch (err) {
      logger.warn(`Failed to parse owo-queue.json: ${(err as Error).message}`);
    }
  }

  private saveQueueToFile(): void {
    if (this.isSaving) {
      this.isSaveQueued = true;
      return;
    }

    this.isSaving = true;
    try {
      const items = Array.from(this.queue.values());
      const tempPath = `${this.filePath}.tmp`;

      if (items.length === 0 && this.globalNextPrayCurseRun <= Date.now()) {
        if (fs.existsSync(this.filePath)) {
          fs.unlinkSync(this.filePath);
        }
      } else {
        const state: OwOPersistedState = {
          globalNextPrayCurseRun: this.globalNextPrayCurseRun,
          items,
        };
        fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tempPath, this.filePath);
      }
    } catch (err) {
      logger.error(`Failed to save owo-queue.json: ${(err as Error).message}`);
    } finally {
      this.isSaving = false;
      if (this.isSaveQueued) {
        this.isSaveQueued = false;
        this.saveQueueToFile();
      }
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    for (const timer of this.scheduledTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduledTimers.clear();
    this.isProcessing = false;
    this.isBattlePending = false;
  }
}
