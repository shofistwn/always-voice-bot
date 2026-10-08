import type { BotConfig } from '../types/config.js';
import type { GuildCreateData, VoiceState } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
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
  private readonly cache?: EntityCache;
  private isInVoice: boolean = false;
  private voiceUsers: Set<string> = new Set();
  private lastJoinAttempt: number = 0;
  private rejoinTimer: NodeJS.Timeout | null = null;
  private deafenTimer: NodeJS.Timeout | null = null;
  private currentSelfDeaf: boolean;
  private currentSelfMute: boolean;

  constructor(config: BotConfig, sender: VoiceGatewaySender, cache?: EntityCache) {
    this.config = config;
    this.sender = sender;
    this.cache = cache;
    this.currentSelfDeaf = config.selfDeaf;
    this.currentSelfMute = config.selfMute;
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

  public setDeaf(deaf: boolean): void {
    this.currentSelfDeaf = deaf;
    if (this.sender.isConnected() && this.isInVoice) {
      try {
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.config.guildId,
          channel_id: this.config.channelId,
          self_mute: this.currentSelfMute,
          self_deaf: deaf,
        });
      } catch (error) {
        logger.error(`Failed to update deaf state: ${(error as Error).message}`);
      }
    }
  }

  public setMute(mute: boolean): void {
    this.currentSelfMute = mute;
    if (this.sender.isConnected() && this.isInVoice) {
      try {
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.config.guildId,
          channel_id: this.config.channelId,
          self_mute: mute,
          self_deaf: this.currentSelfDeaf,
        });
      } catch (error) {
        logger.error(`Failed to update mute state: ${(error as Error).message}`);
      }
    }
  }

  public restoreMute(): void {
    this.setMute(this.config.selfMute);
  }

  public temporaryUndeafen(minSeconds = 300, maxSeconds = 900): void {
    if (!this.config.selfDeaf) {
      return;
    }

    if (this.deafenTimer) {
      clearTimeout(this.deafenTimer);
      this.deafenTimer = null;
    }

    const duration = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    this.setDeaf(false);

    const durationDisplay = duration >= 60 ? `${(duration / 60).toFixed(1)}m` : `${duration}s`;
    logger.info(`Undeafened (woken up). Re-deafening in ${durationDisplay}...`);

    this.deafenTimer = setTimeout(() => {
      this.deafenTimer = null;
      if (this.config.selfDeaf) {
        this.setDeaf(true);
        logger.info('Re-deafened.');
      }
    }, duration * 1000);
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
          self_mute: this.currentSelfMute,
          self_deaf: this.currentSelfDeaf,
        });

        const channelName = this.cache?.getChannelName(this.config.channelId) ?? this.config.channelId;
        logger.info(`Joining ${channelName}...`);
        this.lastJoinAttempt = Date.now();
      } catch (error) {
        logger.error(`Failed to join voice: ${(error as Error).message}`);
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

        const channelName = this.cache?.getChannelName(this.config.channelId) ?? this.config.channelId;
        logger.info(`Left ${channelName} (limit reached).`);
      } catch (error) {
        logger.error(`Failed to leave voice: ${(error as Error).message}`);
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
        logger.info(`Voice limit safe (${currentCount}/${this.config.voiceLimit}). Rejoining...`);
        this.joinVoice();
      }
    } else if (currentCount > this.config.voiceLimit) {
      if (this.isInVoice) {
        logger.warn(`Voice limit exceeded (${currentCount}/${this.config.voiceLimit}). Leaving...`);
        this.leaveVoice();
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData): void {
    if (data.id !== this.config.guildId) {
      return;
    }

    this.voiceUsers.clear();
    for (const vs of data.voice_states ?? []) {
      if (vs.channel_id === this.config.channelId) {
        this.voiceUsers.add(vs.user_id);
      }
    }
    this.checkVoiceLimit();
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    if (!botUserId) {
      return;
    }

    // Handle bot's own voice state
    if (data.user_id === botUserId) {
      const wasInVoice = this.isInVoice;
      this.isInVoice = Boolean(data.channel_id);

      if (wasInVoice && !this.isInVoice) {
        logger.warn('Bot disconnected from voice. Force rejoining in 5s...');
        if (this.rejoinTimer) {
          clearTimeout(this.rejoinTimer);
        }
        this.rejoinTimer = setTimeout(() => {
          this.rejoinTimer = null;
          this.lastJoinAttempt = 0;
          this.joinVoice();
        }, 5000);
      }
      return;
    }

    // Track user counts in target channel
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
    if (this.deafenTimer) {
      clearTimeout(this.deafenTimer);
      this.deafenTimer = null;
    }
  }
}
