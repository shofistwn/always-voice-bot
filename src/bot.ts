import type { BotConfig } from './types/config.js';
import { GatewayClient } from './gateway/gateway-client.js';
import { VoiceManager } from './voice/voice-manager.js';
import { AutoReplyService } from './features/auto-reply.js';
import { createLogger } from './logger/index.js';

const logger = createLogger('Bot');

export class AlwaysVoiceBot {
  private readonly config: BotConfig;
  private readonly gateway: GatewayClient;
  private readonly voiceManager: VoiceManager;
  private readonly autoReply: AutoReplyService;

  private botUserId: string | null = null;
  private botUsername: string = 'Unknown';

  constructor(config: BotConfig) {
    this.config = config;
    this.gateway = new GatewayClient(config);
    this.voiceManager = new VoiceManager(config, this.gateway);
    this.autoReply = new AutoReplyService(config);

    this.registerEventListeners();
  }

  private registerEventListeners(): void {
    this.gateway.on('ready', (data) => {
      this.botUserId = data.user.id;
      this.botUsername = data.user.username;

      this.voiceManager.setInVoice(false);
      this.voiceManager.resetJoinAttempt();
      this.voiceManager.joinVoice();
    });

    this.gateway.on('resumed', () => {
      this.voiceManager.setInVoice(false);
      this.voiceManager.resetJoinAttempt();
      this.voiceManager.joinVoice();
    });

    this.gateway.on('guildCreate', (data) => {
      this.voiceManager.handleGuildCreate(data);
    });

    this.gateway.on('voiceStateUpdate', (data) => {
      this.voiceManager.handleVoiceStateUpdate(data, this.botUserId);
    });

    this.gateway.on('messageCreate', (data) => {
      this.autoReply.handleMessage(data, this.botUserId);
    });
  }

  public start(): void {
    logger.info('Initializing AlwaysVoiceBot engine...');
    this.gateway.connect();
  }

  public stop(): void {
    logger.info('Stopping AlwaysVoiceBot services gracefully...');
    this.autoReply.destroy();
    this.voiceManager.destroy();
    this.gateway.disconnect();
  }
}
