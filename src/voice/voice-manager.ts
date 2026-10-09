import type { BotConfig } from '../types/config.js';
import type { GuildCreateData, VoiceState } from '../types/discord.js';
import type { EntityCache } from '../cache/entity-cache.js';
import { GATEWAY_OPCODES } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';
import { voiceStateStore } from '../config/voice-state.js';

const logger = createLogger('Voice');

export interface VoiceGatewaySender {
  sendOp(op: number, d: unknown): void;
  isConnected(): boolean;
}

export class VoiceManager {
  private readonly config: BotConfig;
  private readonly sender: VoiceGatewaySender;
  private readonly cache?: EntityCache;
  private guildId: string;
  private targetChannelId: string;
  private isInVoice: boolean = false;
  private currentBotChannelId: string | null = null;
  private readonly userVoiceChannels: Map<string, string> = new Map();
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
    this.guildId = voiceStateStore.guildId || config.guildId;
    this.targetChannelId = voiceStateStore.channelId;
    this.currentSelfDeaf = config.music.enabled ? false : config.selfDeaf;
    this.currentSelfMute = config.music.enabled ? false : config.selfMute;
  }

  public getGuildId(): string {
    return this.guildId;
  }

  public setGuildId(guildId: string): void {
    if (guildId && this.guildId !== guildId) {
      this.guildId = guildId;
      voiceStateStore.setGuildId(guildId);
    }
  }

  public getInVoice(): boolean {
    return this.isInVoice;
  }

  public setInVoice(val: boolean): void {
    this.isInVoice = val;
    if (!val) {
      this.currentBotChannelId = null;
    }
  }

  public getTargetChannelId(): string {
    return this.targetChannelId;
  }

  public getCurrentBotChannelId(): string | null {
    return this.isInVoice ? (this.currentBotChannelId || this.targetChannelId) : null;
  }

  public getUserVoiceChannelId(userId: string): string | null {
    return this.userVoiceChannels.get(userId) ?? null;
  }

  public isUserInSameVoice(userId: string): boolean {
    const botChannel = this.getCurrentBotChannelId();
    if (!botChannel) return false;
    const userChannel = this.getUserVoiceChannelId(userId);
    return Boolean(userChannel && userChannel === botChannel);
  }

  public resetJoinAttempt(): void {
    this.lastJoinAttempt = 0;
  }

  public setDeaf(deaf: boolean): void {
    if (this.config.music.enabled && deaf) {
      return;
    }
    this.currentSelfDeaf = deaf;
    const targetChannel = this.currentBotChannelId || this.targetChannelId;
    if (this.sender.isConnected() && this.isInVoice && targetChannel && this.guildId) {
      try {
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.guildId,
          channel_id: targetChannel,
          self_mute: this.currentSelfMute,
          self_deaf: deaf,
        });
      } catch (error) {
        logger.error(`Failed to update deaf state: ${(error as Error).message}`);
      }
    }
  }

  public setMute(mute: boolean): void {
    if (this.config.music.enabled && mute) {
      return;
    }
    this.currentSelfMute = mute;
    const targetChannel = this.currentBotChannelId || this.targetChannelId;
    if (this.sender.isConnected() && this.isInVoice && targetChannel && this.guildId) {
      try {
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.guildId,
          channel_id: targetChannel,
          self_mute: mute,
          self_deaf: this.currentSelfDeaf,
        });
      } catch (error) {
        logger.error(`Failed to update mute state: ${(error as Error).message}`);
      }
    }
  }

  public restoreMute(): void {
    if (this.config.music.enabled) {
      return;
    }
    this.setMute(this.config.selfMute);
  }

  public temporaryUndeafen(minSeconds = 300, maxSeconds = 900): void {
    if (!this.config.selfDeaf || this.config.music.enabled) {
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
      if (this.config.selfDeaf && !this.config.music.enabled) {
        this.setDeaf(true);
        logger.info('Re-deafened (sleep mode restored).');
      }
    }, duration * 1000);
  }

  public joinVoice(overrideChannelId?: string): void {
    const channelId = overrideChannelId || this.targetChannelId;
    if (!channelId) {
      logger.info('No voice channel configured in voice-state.json. Skipping voice connection.');
      return;
    }
    if (!this.guildId) {
      logger.info('No guild ID determined yet. Waiting for guild discovery.');
      return;
    }
    if (!this.sender.isConnected()) {
      logger.warn('Cannot join voice: Gateway is not connected.');
      return;
    }

    const now = Date.now();
    if (now - this.lastJoinAttempt < 10_000 && !overrideChannelId) {
      return;
    }
    this.lastJoinAttempt = now;

    try {
      this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
        guild_id: this.guildId,
        channel_id: channelId,
        self_mute: this.currentSelfMute,
        self_deaf: this.currentSelfDeaf,
      });

      const channelName = this.cache?.getChannelName(channelId) ?? channelId;
      logger.info(`Joining ${channelName}...`);
      this.lastJoinAttempt = Date.now();
    } catch (error) {
      logger.error(`Failed to join voice: ${(error as Error).message}`);
    }
  }

  public switchChannel(newChannelId: string, guildId?: string): void {
    if (!newChannelId) return;

    if (guildId) {
      this.guildId = guildId;
    }
    this.targetChannelId = newChannelId;
    voiceStateStore.setChannelId(newChannelId, this.guildId);

    // Re-filter voice users in the target channel
    this.voiceUsers.clear();
    for (const [userId, chId] of this.userVoiceChannels.entries()) {
      if (chId === newChannelId) {
        this.voiceUsers.add(userId);
      }
    }

    if (this.sender.isConnected() && this.guildId) {
      try {
        this.lastJoinAttempt = 0;
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.guildId,
          channel_id: newChannelId,
          self_mute: this.currentSelfMute,
          self_deaf: this.currentSelfDeaf,
        });

        const channelName = this.cache?.getChannelName(newChannelId) ?? newChannelId;
        logger.info(`Switched voice channel to ${channelName}.`);
        this.lastJoinAttempt = Date.now();
      } catch (error) {
        logger.error(`Failed to switch voice channel: ${(error as Error).message}`);
      }
    }
  }

  public leaveVoice(clearState: boolean = false): void {
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }

    if (clearState) {
      this.targetChannelId = '';
      this.voiceUsers.clear();
      voiceStateStore.clear();
    }

    if (this.sender.isConnected() && this.isInVoice && this.guildId) {
      try {
        this.isInVoice = false;
        this.currentBotChannelId = null;
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        });

        const channelName = this.targetChannelId
          ? this.cache?.getChannelName(this.targetChannelId) ?? this.targetChannelId
          : 'voice';
        logger.info(`Left ${channelName}.`);
      } catch (error) {
        logger.error(`Failed to leave voice: ${(error as Error).message}`);
        this.isInVoice = true;
      }
    }
  }

  public checkVoiceLimit(): void {
    if (this.config.music.enabled || this.config.voiceLimit === 0 || !this.targetChannelId) {
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
        this.leaveVoice(false);
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData, botUserId?: string | null): void {
    if (!this.guildId) {
      this.guildId = data.id;
      voiceStateStore.setGuildId(data.id);
    }

    if (data.id !== this.guildId) {
      return;
    }

    this.voiceUsers.clear();
    this.userVoiceChannels.clear();

    for (const vs of data.voice_states ?? []) {
      if (vs.channel_id) {
        this.userVoiceChannels.set(vs.user_id, vs.channel_id);
        if (botUserId && vs.user_id === botUserId) {
          this.currentBotChannelId = vs.channel_id;
          this.isInVoice = true;
        }
        if (this.targetChannelId && vs.channel_id === this.targetChannelId) {
          this.voiceUsers.add(vs.user_id);
        }
      }
    }
    this.checkVoiceLimit();
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    if (!botUserId) {
      return;
    }
    if (this.guildId && data.guild_id && data.guild_id !== this.guildId) {
      return;
    }

    if (data.channel_id) {
      this.userVoiceChannels.set(data.user_id, data.channel_id);
    } else {
      this.userVoiceChannels.delete(data.user_id);
    }

    // Handle bot's own voice state
    if (data.user_id === botUserId) {
      const wasInVoice = this.isInVoice;
      this.currentBotChannelId = data.channel_id;
      this.isInVoice = Boolean(data.channel_id);

      if (wasInVoice && !this.isInVoice) {
        if (!this.targetChannelId) return;
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
    const targetChannel = this.currentBotChannelId || this.targetChannelId;
    if (targetChannel && data.channel_id === targetChannel) {
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
    this.userVoiceChannels.clear();
    this.voiceUsers.clear();
  }
}
