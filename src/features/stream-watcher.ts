import type { BotConfig } from '../types/config.js';
import type { GuildCreateData, StreamCreateData, StreamDeleteData, VoiceState } from '../types/discord.js';
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
  private readonly activeStreams: Set<string> = new Set();

  constructor(config: BotConfig, sender: StreamGatewaySender) {
    this.config = config;
    this.sender = sender;
  }

  public handleGuildCreate(data: GuildCreateData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || data.id !== this.config.guildId) {
      return;
    }

    for (const vs of data.voice_states || []) {
      if (vs.channel_id === this.config.channelId && vs.self_stream) {
        if (botUserId && vs.user_id === botUserId) {
          continue;
        }
        const targetKey = `guild:${this.config.guildId}:${this.config.channelId}:${vs.user_id}`;
        this.watchStream(targetKey, vs.user_id);
      }
    }
  }

  public handleStreamCreate(data: StreamCreateData, botUserId: string | null): void {
    if (!this.config.autoWatchStream || !data.stream_key) {
      return;
    }

    const parts = data.stream_key.split(':');
    if (parts[0] === 'guild') {
      const [, guildId, channelId, streamerId] = parts;

      if (guildId === this.config.guildId && channelId === this.config.channelId) {
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

    const targetKey = `guild:${this.config.guildId}:${this.config.channelId}:${data.user_id}`;

    // User is in target voice channel and streaming
    if (data.channel_id === this.config.channelId && data.self_stream) {
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

      const userDisplay = streamerId ? `user ${streamerId}` : 'streamer';
      logger.success(`Watching stream from ${userDisplay}`);
    } catch (error) {
      logger.warn(`Failed to send STREAM_WATCH: ${(error as Error).message}`);
    }
  }

  public unwatchStream(streamKey: string): void {
    if (!this.activeStreams.has(streamKey)) {
      return;
    }

    try {
      if (this.sender.isConnected()) {
        this.sender.sendOp(GATEWAY_OPCODES.STREAM_DELETE, {
          stream_key: streamKey,
        });
      }
      this.activeStreams.delete(streamKey);
      logger.info(`Stream ended (${streamKey}). Stopped watching.`);
    } catch (error) {
      logger.warn(`Failed to send STREAM_DELETE: ${(error as Error).message}`);
      this.activeStreams.delete(streamKey);
    }
  }

  public clearAll(): void {
    for (const streamKey of this.activeStreams) {
      this.unwatchStream(streamKey);
    }
    this.activeStreams.clear();
  }

  public destroy(): void {
    this.clearAll();
  }
}
