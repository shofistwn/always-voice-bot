import type { BotConfig } from '../types/config.js';
import type {
  GuildCreateData,
  ReadyEventData,
  StreamCreateData,
  StreamDeleteData,
  VoiceState,
} from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import { GATEWAY_OPCODES } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Stream');

export interface StreamGatewaySender {
  sendOp(op: number, d: unknown): void;
  isConnected(): boolean;
}

export class StreamWatcherService {
  private readonly config: BotConfig;
  private readonly sender: StreamGatewaySender;
  private readonly cache?: EntityCache;
  private readonly activeStreams: Set<string> = new Set();
  private readonly streamerUserIds: Set<string> = new Set();
  private isBotInVoice: boolean = false;

  constructor(
    config: BotConfig,
    sender: StreamGatewaySender,
    cache?: EntityCache
  ) {
    this.config = config;
    this.sender = sender;
    this.cache = cache;
  }

  private extractStreamerId(streamKey: string): string {
    const parts = streamKey.split(':');
    return parts[parts.length - 1] || 'unknown';
  }

  public handleReady(data: ReadyEventData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || !Array.isArray(data.guilds)) {
      return;
    }

    for (const guild of data.guilds) {
      if (guild.id === this.config.guildId) {
        this.handleGuildCreate(guild, botUserId);
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || data.id !== this.config.guildId) {
      return;
    }

    const targetChannel = this.config.channelId;
    if (!targetChannel) {
      return;
    }

    for (const vs of data.voice_states || []) {
      if (vs.channel_id === targetChannel && vs.self_stream) {
        if (botUserId && vs.user_id === botUserId) {
          continue;
        }
        this.streamerUserIds.add(vs.user_id);
        const targetKey = `guild:${data.id}:${targetChannel}:${vs.user_id}`;
        if (this.isBotInVoice) {
          this.watchStream(targetKey, vs.user_id);
        }
      }
    }
  }

  public handleStreamCreate(data: StreamCreateData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || !data.stream_key) {
      return;
    }

    const targetChannel = this.config.channelId;
    if (!targetChannel) {
      return;
    }

    const parts = data.stream_key.split(':');
    if (parts[0] === 'guild') {
      const [, guildId, channelId, streamerId] = parts;

      if (guildId === this.config.guildId && channelId === targetChannel) {
        if (botUserId && streamerId === botUserId) {
          return;
        }
        this.streamerUserIds.add(streamerId);
        if (this.isBotInVoice) {
          this.watchStream(data.stream_key, streamerId);
        }
      }
    }
  }

  public handleStreamDelete(data: StreamDeleteData): void {
    if (!data.stream_key) {
      return;
    }

    const streamerId = this.extractStreamerId(data.stream_key);
    this.streamerUserIds.delete(streamerId);

    if (this.activeStreams.has(data.stream_key)) {
      this.unwatchStream(data.stream_key);
    }
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    if (!this.config.autoWatchStream) {
      return;
    }

    const targetChannel = this.config.channelId;
    if (!targetChannel) {
      return;
    }

    // Handle bot's own voice state
    if (botUserId && data.user_id === botUserId) {
      const joinedTargetVoice = data.channel_id === targetChannel;
      this.isBotInVoice = joinedTargetVoice;

      if (joinedTargetVoice) {
        // Bot just entered or confirmed presence in target voice: watch all active streamers
        this.rescanAndWatchActiveStreams();
      } else if (data.channel_id === null) {
        // Bot left voice channel: stop watching and clear
        this.clearAll();
      }
      return;
    }

    const isTargetGuild = !data.guild_id || data.guild_id === this.config.guildId;
    if (!isTargetGuild) {
      return;
    }

    const targetKey = `guild:${this.config.guildId}:${targetChannel}:${data.user_id}`;

    // User is in target voice channel and streaming
    if (data.channel_id === targetChannel && data.self_stream) {
      this.streamerUserIds.add(data.user_id);
      if (this.isBotInVoice && !this.activeStreams.has(targetKey)) {
        this.watchStream(targetKey, data.user_id);
      }
    } else {
      // User left target channel or stopped streaming
      this.streamerUserIds.delete(data.user_id);
      if (this.activeStreams.has(targetKey)) {
        this.unwatchStream(targetKey);
      }
    }
  }

  private rescanAndWatchActiveStreams(): void {
    const targetChannel = this.config.channelId;
    if (!targetChannel || !this.isBotInVoice) {
      return;
    }

    for (const streamerId of this.streamerUserIds) {
      const targetKey = `guild:${this.config.guildId}:${targetChannel}:${streamerId}`;
      if (!this.activeStreams.has(targetKey)) {
        this.watchStream(targetKey, streamerId);
      }
    }
  }

  public watchStream(streamKey: string, streamerId?: string): void {
    if (!this.sender.isConnected() || this.activeStreams.has(streamKey)) {
      return;
    }

    try {
      this.sender.sendOp(GATEWAY_OPCODES.STREAM_WATCH, {
        stream_key: streamKey,
      });
      this.activeStreams.add(streamKey);

      const userId = streamerId ?? this.extractStreamerId(streamKey);
      const username = this.cache?.getUserName(userId) ?? userId;
      logger.info(`Watching stream from ${username} (${streamKey})`);
    } catch (error) {
      logger.error(`Failed to watch stream: ${(error as Error).message}`);
    }
  }

  public unwatchStream(streamKey: string): void {
    if (!this.activeStreams.has(streamKey)) {
      return;
    }

    this.activeStreams.delete(streamKey);
    const userId = this.extractStreamerId(streamKey);
    const username = this.cache?.getUserName(userId) ?? userId;
    logger.info(`Stopped watching stream from ${username}`);
  }

  public clearAll(): void {
    this.activeStreams.clear();
  }

  public destroy(): void {
    this.streamerUserIds.clear();
    this.clearAll();
  }
}
