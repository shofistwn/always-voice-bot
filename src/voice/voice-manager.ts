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
  private currentSelfDeaf: boolean;
  private currentSelfMute: boolean;

  constructor(config: BotConfig, sender: VoiceGatewaySender, cache?: EntityCache) {
    this.config = config;
    this.sender = sender;
    this.cache = cache;
    this.currentSelfDeaf = config.selfDeaf;
    this.currentSelfMute = config.selfMute;
  }

  public setInVoice(val: boolean): void {
    this.isInVoice = val;
  }

  public resetJoinAttempt(): void {
    this.lastJoinAttempt = 0;
  }

  public joinVoice(): void {
    const channelId = this.config.channelId;
    if (!channelId) {
      logger.error('Missing CHANNEL_ID in environment variables. Cannot join voice.');
      return;
    }
    if (!this.config.guildId) {
      logger.error('Missing GUILD_ID in environment variables. Cannot join voice.');
      return;
    }
    if (!this.sender.isConnected()) {
      logger.warn('Cannot join voice: Gateway is not connected.');
      return;
    }

    const now = Date.now();
    if (now - this.lastJoinAttempt < 10_000) {
      return;
    }
    this.lastJoinAttempt = now;

    try {
      this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
        guild_id: this.config.guildId,
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

  public leaveVoice(): void {
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }

    if (this.sender.isConnected() && this.isInVoice && this.config.guildId) {
      try {
        this.isInVoice = false;
        this.sender.sendOp(GATEWAY_OPCODES.VOICE_STATE_UPDATE, {
          guild_id: this.config.guildId,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        });

        const channelName = this.config.channelId
          ? this.cache?.getChannelName(this.config.channelId) ?? this.config.channelId
          : 'voice';
        logger.info(`Left ${channelName}.`);
      } catch (error) {
        logger.error(`Failed to leave voice: ${(error as Error).message}`);
        this.isInVoice = true;
      }
    }
  }

  public checkVoiceLimit(): void {
    if (this.config.voiceLimit === 0 || !this.config.channelId) {
      return;
    }

    const humanCount = this.voiceUsers.size;
    const totalOccupants = humanCount + (this.isInVoice ? 1 : 0);

    // Option 2 (Total Room Capacity): Leave if total occupants > limit
    if (totalOccupants > this.config.voiceLimit) {
      if (this.isInVoice) {
        logger.warn(
          `Voice limit exceeded (${totalOccupants}/${this.config.voiceLimit} total). Leaving...`
        );
        this.leaveVoice();
      }
    } else if (humanCount + 1 <= this.config.voiceLimit) {
      // Rejoin only if adding the bot stays within the room limit
      if (!this.isInVoice) {
        logger.info(
          `Voice limit safe (${humanCount + 1}/${this.config.voiceLimit} with bot). Rejoining...`
        );
        this.joinVoice();
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData, botUserId?: string | null): void {
    if (data.id !== this.config.guildId) {
      return;
    }

    this.voiceUsers.clear();
    for (const vs of data.voice_states ?? []) {
      if (vs.channel_id === this.config.channelId) {
        if (botUserId && vs.user_id === botUserId) {
          this.isInVoice = true;
          continue;
        }
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
        if (!this.config.channelId) return;
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

    // Track user counts in target channel for the active guild
    const isTargetGuild = !data.guild_id || data.guild_id === this.config.guildId;
    if (isTargetGuild && data.channel_id === this.config.channelId) {
      this.voiceUsers.add(data.user_id);
    } else if (isTargetGuild) {
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
