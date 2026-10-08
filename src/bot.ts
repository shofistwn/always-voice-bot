import type { BotConfig } from './types/config.js';
import { GatewayClient } from './gateway/gateway-client.js';
import { VoiceManager } from './voice/voice-manager.js';
import { EntityCache } from './cache/entity-cache.js';
import { AutoReplyService } from './features/auto-reply.js';
import { StreamWatcherService } from './features/stream-watcher.js';
import { MusicService } from './features/music/music-service.js';
import { createLogger } from './logger/index.js';

const logger = createLogger('Bot');

export class AlwaysVoiceBot {
  private readonly config: BotConfig;
  private readonly gateway: GatewayClient;
  private readonly voiceManager: VoiceManager;
  private readonly cache: EntityCache;
  private readonly autoReply: AutoReplyService;
  private readonly streamWatcher: StreamWatcherService;
  private readonly musicService?: MusicService;

  private botUserId: string | null = null;
  private botUsername: string | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.cache = new EntityCache();
    this.gateway = new GatewayClient(config);
    this.voiceManager = new VoiceManager(config, this.gateway, this.cache);
    this.autoReply = new AutoReplyService(config, this.cache);
    this.streamWatcher = new StreamWatcherService(config, this.gateway, this.cache);

    if (config.music.enabled) {
      this.musicService = new MusicService(config, this.voiceManager, this.cache);
    }

    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    this.gateway.on('ready', (data) => {
      this.botUserId = data.user.id;
      this.botUsername = data.user.username;

      this.cache.handleReady(data);
      this.voiceManager.setInVoice(false);
      this.voiceManager.resetJoinAttempt();
      this.voiceManager.joinVoice();

      this.musicService?.start(data.user.id);
    });

    this.gateway.on('guildCreate', (data) => {
      this.cache.handleGuildCreate(data);
      this.voiceManager.handleGuildCreate(data, this.botUserId);
      this.streamWatcher.handleGuildCreate(data, this.botUserId);
    });

    this.gateway.on('voiceStateUpdate', (data) => {
      this.cache.handleVoiceStateUpdate(data);
      this.voiceManager.handleVoiceStateUpdate(data, this.botUserId);
      this.streamWatcher.handleVoiceStateUpdate(data, this.botUserId);
      this.musicService?.handleVoiceStateUpdate(data, this.botUserId);
    });

    this.gateway.on('voiceServerUpdate', (data) => {
      this.musicService?.handleVoiceServerUpdate(data);
    });

    this.gateway.on('messageCreate', (data) => {
      this.cache.handleMessageCreate(data);
      this.autoReply.handleMessage(data, this.botUserId);
      this.musicService?.handleMessage(data, this.botUserId);
    });

    this.gateway.on('streamCreate', (data) => {
      this.streamWatcher.handleStreamCreate(data, this.botUserId);
    });

    this.gateway.on('streamDelete', (data) => {
      this.streamWatcher.handleStreamDelete(data);
    });

    this.autoReply.on('trigger', () => {
      this.voiceManager.temporaryUndeafen(
        this.config.autoReply.undeafenMinSeconds,
        this.config.autoReply.undeafenMaxSeconds
      );
    });
  }

  public start(): void {
    logger.info('Starting AlwaysVoiceBot...');
    this.gateway.connect();
  }

  public stop(): void {
    logger.info('Stopping AlwaysVoiceBot...');
    this.musicService?.destroy();
    this.streamWatcher.destroy();
    this.autoReply.destroy();
    this.voiceManager.destroy();
    this.cache.clear();
    this.gateway.disconnect();
  }
}
