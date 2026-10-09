import 'dotenv/config';
import type { BotConfig, OnlineStatus } from '../types/config.js';
import { createLogger } from '../logger/index.js';
import { voiceStateStore } from './voice-state.js';

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

function parseStringList(val: string | undefined): string[] {
  if (!val) return [];
  return val
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): BotConfig {
  const token = process.env.TOKEN?.trim() || '';
  const guildId = voiceStateStore.guildId || process.env.GUILD_ID?.trim() || '';
  const channelId = voiceStateStore.channelId;

  if (!token) {
    logger.error('Missing required environment variable: TOKEN');
  }
  if (!guildId) {
    logger.info('No guild ID set in voice-state.json. Guild will be detected automatically on connection.');
  }
  if (!channelId) {
    logger.info('No voice channel set in voice-state.json. Bot will stay disconnected until a channel is selected.');
  }

  const voiceAllowedUserIds = parseStringList(
    process.env.VOICE_ALLOWED_USER_IDS || process.env.VOICE_ALLOWED_USERS
  );

  const musicEnabled = parseBoolean(process.env.MUSIC_ENABLED, true);
  const selfMute = musicEnabled ? false : parseBoolean(process.env.SELF_MUTE, true);
  const selfDeaf = musicEnabled ? false : parseBoolean(process.env.SELF_DEAF, false);
  const autoReplyEnabled = musicEnabled ? false : parseBoolean(process.env.AUTO_REPLY, false);
  const voiceLimit = musicEnabled ? 0 : parseNumber(process.env.VOICE_LIMIT, 0);

  if (musicEnabled) {
    logger.info('Music mode enabled: AUTO_REPLY, SELF_MUTE, SELF_DEAF, and VOICE_LIMIT are ignored.');
  }

  return {
    token,
    guildId,
    channelId,
    voiceLimit,
    voiceAllowedUserIds,
    status: parseStatus(process.env.STATUS, 'dnd'),
    selfMute,
    selfDeaf,
    autoWatchStream: parseBoolean(process.env.AUTO_WATCH_STREAM, true),
    autoReply: {
      enabled: autoReplyEnabled,
      trigger: (process.env.REPLY_TRIGGER || 'hey wake up!').trim().toLowerCase(),
      message: process.env.REPLY_MESSAGE || 'yes',
      delaySeconds: parseNumber(process.env.REPLY_DELAY, 5),
      undeafenMinSeconds: parseNumber(process.env.UNDEAFEN_MIN_SECONDS, 300),
      undeafenMaxSeconds: parseNumber(process.env.UNDEAFEN_MAX_SECONDS, 900),
    },
    music: {
      enabled: musicEnabled,
      prefix: (process.env.MUSIC_PREFIX || '!').trim(),
      nodelinkHost: process.env.NODELINK_HOST || 'localhost',
      nodelinkPort: parseNumber(process.env.NODELINK_PORT, 3000),
      nodelinkPassword: process.env.NODELINK_PASSWORD || 'youshallnotpass',
      nodelinkSecure: parseBoolean(process.env.NODELINK_SECURE, false),
    },
  };
}

export const config = loadConfig();
