import 'dotenv/config';
import type { BotConfig, OnlineStatus } from '../types/config.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Config');

function parseBoolean(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined || val === '') return defaultVal;
  return val.trim().toLowerCase() === 'true';
}

function parseNumber(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val === '') return defaultVal;
  const parsed = parseInt(val.trim(), 10);
  return Number.isNaN(parsed) ? defaultVal : parsed;
}

function parseStatus(val: string | undefined, defaultVal: OnlineStatus): OnlineStatus {
  const normalized = (val || '').trim().toLowerCase();
  if (['online', 'idle', 'dnd', 'invisible'].includes(normalized)) {
    return normalized as OnlineStatus;
  }
  return defaultVal;
}

export function loadConfig(): BotConfig {
  const token = process.env.TOKEN?.trim() || '';
  const guildId = process.env.GUILD_ID?.trim() || '';
  const channelId = process.env.CHANNEL_ID?.trim() || '';

  if (!token) {
    logger.error('Missing required environment variable: TOKEN');
  }
  if (!guildId) {
    logger.error('Missing required environment variable: GUILD_ID');
  }
  if (!channelId) {
    logger.error('Missing required environment variable: CHANNEL_ID');
  }

  return {
    token,
    guildId,
    channelId,
    voiceLimit: parseNumber(process.env.VOICE_LIMIT, 0),
    status: parseStatus(process.env.STATUS, 'dnd'),
    selfMute: parseBoolean(process.env.SELF_MUTE, true),
    selfDeaf: parseBoolean(process.env.SELF_DEAF, false),
    autoWatchStream: parseBoolean(process.env.AUTO_WATCH_STREAM, true),
    autoReply: {
      enabled: parseBoolean(process.env.AUTO_REPLY, false),
      trigger: (process.env.REPLY_TRIGGER || 'hey wake up!').trim().toLowerCase(),
      message: process.env.REPLY_MESSAGE || 'yes',
      delaySeconds: parseNumber(process.env.REPLY_DELAY, 5),
      undeafenMinSeconds: parseNumber(process.env.UNDEAFEN_MIN_SECONDS, 300),
      undeafenMaxSeconds: parseNumber(process.env.UNDEAFEN_MAX_SECONDS, 900),
    },
  };
}

export const config = loadConfig();
