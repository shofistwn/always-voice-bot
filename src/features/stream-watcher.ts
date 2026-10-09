import type { BotConfig } from '../types/config.js';
import type { GuildCreateData, StreamCreateData, StreamDeleteData, VoiceState } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import type { VoiceManager } from '../voice/voice-manager.js';
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
  private readonly voiceManager?: VoiceManager;
  private readonly activeStreams: Set<string> = new Set();

  constructor(
    config: BotConfig,
    sender: StreamGatewaySender,
    cache?: EntityCache,
    voiceManager?: VoiceManager
  ) {
    this.config = config;
    this.sender = sender;
    this.cache = cache;
    this.voiceManager = voiceManager;
  }

  private getTargetChannelId(): string {
    return (
      this.voiceManager?.getCurrentBotChannelId() ||
      this.voiceManager?.getTargetChannelId() ||
      this.config.channelId
    );
  }

  private getGuildId(): string {
    return this.voiceManager?.getGuildId() || this.config.guildId;
  }

  private extractStreamerId(streamKey: string): string {
    const parts = streamKey.split(':');
    return parts[parts.length - 1] || 'unknown';
  }

  public handleGuildCreate(data: GuildCreateData, botUserId: string | null): void {
    const currentGuildId = this.getGuildId();
    if (!this.config.autoWatchStream || (currentGuildId && data.id !== currentGuildId)) {
      return;
    }

    const targetChannel = this.getTargetChannelId();
    if (!targetChannel) {
      return;
    }

    for (const vs of data.voice_states || []) {
      if (vs.channel_id === targetChannel && vs.self_stream) {
        if (botUserId && vs.user_id === botUserId) {
          continue;
        }
        const targetKey = `guild:${data.id}:${targetChannel}:${vs.user_id}`;
        this.watchStream(targetKey, vs.user_id);
      }
    }
  }

  public handleStreamCreate(data: StreamCreateData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || !data.stream_key) {
      return;
    }

    const targetChannel = this.getTargetChannelId();
    const currentGuildId = this.getGuildId();
    if (!targetChannel) {
      return;
    }

    const parts = data.stream_key.split(':');
    if (parts[0] === 'guild') {
      const [, guildId, channelId, streamerId] = parts;

      if ((!currentGuildId || guildId === currentGuildId) && channelId === targetChannel) {
        if (botUserId && streamerId === botUserId) {
          return;
        }
        this.watchStream(data.stream_key, streamerId);
      }
    }
  }

  public handleStreamDelete(data: StreamDeleteData): void {
    if (!data.stream_key) {
      return;
    }

    if (this.activeStreams.has(data.stream_key)) {
      this.unwatchStream(data.stream_key);
    }
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    if (!this.config.autoWatchStream) {
      return;
    }

    // Ignore bot's own voice state
    if (botUserId && data.user_id === botUserId) {
      // If bot left voice channel, clear all watched streams
      if (data.channel_id === null) {
        this.clearAll();
      }
      return;
    }

    const targetChannel = this.getTargetChannelId();
    const currentGuildId = this.getGuildId();
    if (!targetChannel) {
      return;
    }

    const targetKey = `guild:${currentGuildId || data.guild_id}:${targetChannel}:${data.user_id}`;

    // User is in target voice channel and streaming
    if (data.channel_id === targetChannel && data.self_stream) {
      if (!this.activeStreams.has(targetKey)) {
        this.watchStream(targetKey, data.user_id);
      }
    } else {
      // User left target channel or stopped streaming
      if (this.activeStreams.has(targetKey)) {
        this.unwatchStream(targetKey);
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
    this.clearAll();
  }
}
