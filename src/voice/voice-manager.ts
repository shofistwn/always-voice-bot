import type { BotConfig } from '../types/config.js';
import type { GuildCreateData, VoiceState } from '../types/discord.js';
import { GATEWAY_OPCODES } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Voice');

export interface VoiceGatewaySender {
  sendOp(op: number, d: unknown): void;
  isConnected(): boolean;
}

export class VoiceManager {
  private readonly config: BotConfig;
  private readonly sender: VoiceGatewaySender;
  private isInVoice: boolean = false;
  private voiceUsers: Set<string> = new Set();
  private lastJoinAttempt: number = 0;
  private rejoinTimer: NodeJS.Timeout | null = null;

  constructor(config: BotConfig, sender: VoiceGatewaySender) {
    this.config = config;
    this.sender = sender;
  }

  public getInVoice(): boolean {
    return this.isInVoice;
  }

  public setInVoice(val: boolean): void {
    this.isInVoice = val;
  }

  public resetJoinAttempt(): void {
    this.lastJoinAttempt = 0;
  }

  public joinVoice(): void {
    const now = Date.now();
    if (now - this.lastJoinAttempt < 10_000) {
      return;
    }

    if (this.sender.isConnected() && !this.isInVoice) {
      try {
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.config.guildId,
          channel_id: this.config.channelId,
          self_mute: this.config.selfMute,
          self_deaf: this.config.selfDeaf,
        });
        logger.info(
          `Joining channel ${this.config.channelId} (guild: ${this.config.guildId}, mute: ${this.config.selfMute}, deaf: ${this.config.selfDeaf})`
        );
        this.lastJoinAttempt = Date.now();
      } catch (error) {
        logger.error(`Voice join dispatch failed: ${(error as Error).message}`);
      }
    }
  }

  public leaveVoice(): void {
    if (this.sender.isConnected() && this.isInVoice) {
      try {
        this.isInVoice = false;
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.config.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        });
        logger.info(`Left channel ${this.config.channelId} due to occupancy limit.`);
      } catch (error) {
        logger.error(`Voice leave dispatch failed: ${(error as Error).message}`);
        this.isInVoice = true;
      }
    }
  }

  public checkVoiceLimit(): void {
    if (this.config.voiceLimit === 0) {
      return;
    }

    const currentCount = this.voiceUsers.size;
    if (currentCount < this.config.voiceLimit) {
      if (!this.isInVoice) {
        logger.info(`Occupancy safe (${currentCount}/${this.config.voiceLimit}). Rejoining voice channel.`);
        this.joinVoice();
      }
    } else if (currentCount > this.config.voiceLimit) {
      if (this.isInVoice) {
        logger.warn(`Occupancy over limit (${currentCount} > ${this.config.voiceLimit}). Leaving channel immediately.`);
        this.leaveVoice();
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData): void {
    if (data.id !== this.config.guildId) {
      return;
    }

    this.voiceUsers.clear();
    for (const vs of data.voice_states || []) {
      if (vs.channel_id === this.config.channelId) {
        this.voiceUsers.add(vs.user_id);
      }
    }
    logger.debug(`Synchronized guild voice states: ${this.voiceUsers.size} user(s) in target channel`);
    this.checkVoiceLimit();
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    // Handle bot's own voice state
    if (botUserId && data.user_id === botUserId) {
      const wasInVoice = this.isInVoice;
      this.isInVoice = data.channel_id !== null;

      if (this.isInVoice && !wasInVoice) {
        logger.success(`Active in voice channel ${this.config.channelId}`);
      } else if (wasInVoice && !this.isInVoice) {
        logger.warn('Bot disconnected from voice channel. Scheduling rejoin in 5 seconds...');
        if (this.rejoinTimer) {
          clearTimeout(this.rejoinTimer);
        }
        this.rejoinTimer = setTimeout(() => {
          this.lastJoinAttempt = 0;
          this.joinVoice();
        }, 5000);
        return;
      }
    }

    // Track channel occupancy for limit enforcement
    if (data.channel_id === this.config.channelId) {
      this.voiceUsers.add(data.user_id);
    } else {
      this.voiceUsers.delete(data.user_id);
    }

    this.checkVoiceLimit();
  }

  public destroy(): void {
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }
}
