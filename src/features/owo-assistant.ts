import fs from 'node:fs';
import path from 'node:path';
import type { BotConfig } from '../types/config.js';
import type { MessageCreateData } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import type { DiscordApiClient } from '../api/discord-client.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('OwOAssist');

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

/**
 * Generates human-like delay for pray/curse cooldown using a Gaussian-like distribution.
 * Simulates a person checking back between ~20s and ~65s after the 5-minute cooldown.
 */
function calculateHumanizedPrayCurseInterval(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const normal = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
  const extraSeconds = Math.max(20, Math.min(75, 40 + normal * 12));
  return PRAY_CURSE_COOLDOWN_MS + Math.floor(extraSeconds * 1000);
}

/**
 * Generates natural delay for cookies (18s - 34s) to avoid robotic burst patterns.
 */
function calculateHumanizedCookieInterval(): number {
  return Math.floor(Math.random() * 16000) + 18000;
}

export class OwoAssistantService {
  private readonly config: BotConfig;
  private readonly apiClient: DiscordApiClient;
  private readonly cache?: EntityCache;
  private readonly filePath: string;

  private queue: Map<string, OwOQueueItem> = new Map();
  private scheduledTimers: Map<string, NodeJS.Timeout> = new Map();
  private globalNextPrayCurseRun: number = 0;
  private isProcessing: boolean = false;
  private currentlyExecutingId: string | null = null; // Lock for active executing item
  private isBattlePending: boolean = false;
  private isSaveQueued: boolean = false;
  private isSaving: boolean = false;
  private isDestroyed: boolean = false;

  constructor(config: BotConfig, apiClient: DiscordApiClient, cache?: EntityCache) {
    this.config = config;
    this.apiClient = apiClient;
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

    // Ignore messages from this bot
    if (message.author.id === botUserId) {
      return;
    }

    // Check if this bot is mentioned
    const isMentioned = message.mentions.some((m) => m.id === botUserId);
    if (!isMentioned) {
      return;
    }

    this.handleUserMention(message);
  }

  private handleUserMention(message: MessageCreateData): void {
    const rawContent = (message.content || '').toLowerCase();
    const authorId = message.author.id;
    const channelId = message.channel_id;

    // Check for battle triggers: wb @mention, w b @mention, owob @mention, owo b @mention, owo battle @mention
    const isBattleTrigger = /\b(wb|w\s+b|owob|owo\s+b|w\s+battle|owo\s+battle|battle)\b/.test(rawContent);

    if (isBattleTrigger) {
      if (this.isBattlePending) return;
      this.isBattlePending = true;

      const battleDelayMs = Math.floor(Math.random() * 3000) + 3500; // 3.5s - 6.5s randomized
      logger.info(
        `Battle challenge detected from ${message.author.username} ("${message.content}"). Responding with "owo ab" in ${(battleDelayMs / 1000).toFixed(1)}s...`
      );

      setTimeout(async () => {
        try {
          if (this.isDestroyed) return;
          await this.apiClient.sendTyping(channelId);
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 800) + 900));
          const success = await this.apiClient.sendMessage(channelId, 'owo ab');
          if (success) {
            logger.success(`Sent "owo ab" in response to battle trigger from ${message.author.username}!`);
          }
        } finally {
          this.isBattlePending = false;
        }
      }, battleDelayMs);
      return;
    }

    // Detect quest intent (cookie, pray, curse)
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

      // Only schedule if no timer exists AND item is not currently executing
      if (!this.scheduledTimers.has(queueKey) && this.currentlyExecutingId !== queueKey) {
        this.scheduleItem(existing);
      }
      return;
    }

    const now = Date.now();
    let initialRun = now;

    if (action === 'pray' || action === 'curse') {
      let latestPrayCurseRun = this.globalNextPrayCurseRun;
      for (const item of this.queue.values()) {
        if ((item.action === 'pray' || item.action === 'curse') && item.nextRun > latestPrayCurseRun) {
          latestPrayCurseRun = item.nextRun;
        }
      }

      if (latestPrayCurseRun > now) {
        initialRun = latestPrayCurseRun;
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
    this.currentlyExecutingId = itemId;

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

      const commandText = `owo ${item.action} <@${item.userId}>`;

      // Natural typing simulation: scale with command length + human reaction time
      const simulatedTypingMs = Math.min(
        3200,
        Math.max(1200, commandText.length * 80 + Math.floor(Math.random() * 600))
      );

      await this.apiClient.sendTyping(item.channelId);
      await new Promise((resolve) => setTimeout(resolve, simulatedTypingMs));

      const success = await this.apiClient.sendMessage(item.channelId, commandText);

      if (success) {
        item.remainingCount -= 1;
        const channelName = this.cache?.getChannelName(item.channelId) ?? item.channelId;
        logger.success(
          `Executed: "${commandText}" in #${channelName} (Remaining: ${item.remainingCount})`
        );

        if (item.action === 'pray' || item.action === 'curse') {
          const cooldownInterval = calculateHumanizedPrayCurseInterval();
          this.globalNextPrayCurseRun = Date.now() + cooldownInterval;

          // Round-Robin Fair Scheduling:
          const otherPrayCurseItems: OwOQueueItem[] = [];
          for (const [key, queuedItem] of this.queue.entries()) {
            if (
              key !== itemId &&
              (queuedItem.action === 'pray' || queuedItem.action === 'curse') &&
              queuedItem.remainingCount > 0
            ) {
              otherPrayCurseItems.push(queuedItem);
            }
          }

          if (item.remainingCount <= 0) {
            logger.success(`Completed all ${item.action} requests for user ${item.userId}!`);
            this.queue.delete(itemId);
          }

          if (otherPrayCurseItems.length > 0) {
            let nextSlot = this.globalNextPrayCurseRun;
            for (const other of otherPrayCurseItems) {
              other.nextRun = nextSlot;
              this.scheduleItem(other);
              nextSlot += calculateHumanizedPrayCurseInterval();
            }

            if (item.remainingCount > 0) {
              item.nextRun = nextSlot;
              this.scheduleItem(item);
            }
          } else if (item.remainingCount > 0) {
            item.nextRun = this.globalNextPrayCurseRun;
            this.scheduleItem(item);
          }

          this.saveQueueToFile();
        } else {
          // Cookie
          if (item.remainingCount <= 0) {
            logger.success(`Completed all ${item.action} requests for user ${item.userId}!`);
            this.queue.delete(itemId);
          } else {
            const nextCooldown = calculateHumanizedCookieInterval();
            item.nextRun = Date.now() + nextCooldown;
            this.scheduleItem(item);
          }
          this.saveQueueToFile();
        }
      } else {
        logger.warn(`Failed to send ${item.action}. Backing off for 35 seconds...`);
        item.nextRun = Date.now() + 35000;
        this.saveQueueToFile();
        this.scheduleItem(item);
      }
    } catch (err) {
      logger.error(`Error executing queue item ${itemId}: ${(err as Error).message}`);
    } finally {
      this.isProcessing = false;
      this.currentlyExecutingId = null;
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
        this.globalNextPrayCurseRun =
          typeof parsed.globalNextPrayCurseRun === 'number' ? parsed.globalNextPrayCurseRun : 0;
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
    this.currentlyExecutingId = null;
    this.isBattlePending = false;
  }
}
