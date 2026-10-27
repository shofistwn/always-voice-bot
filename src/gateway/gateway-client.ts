import EventEmitter from 'node:events';
import { WebSocket } from 'ws';
import type { BotConfig } from '../types/config.js';
import type {
  GatewayPayload,
  HelloData,
  ReadyEventData,
  ReadySupplementalData,
  GuildCreateData,
  VoiceState,
  MessageCreateData,
  StreamCreateData,
  StreamDeleteData,
} from '../types/discord.js';
import {
  GATEWAY_OPCODES,
  DISCORD_GATEWAY,
  DISCORD_CLIENT_PROPERTIES,
} from '../constants/discord.js';
import { HeartbeatManager, type HeartbeatSender } from './heartbeat.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Gateway');

export interface GatewayClientEvents {
  ready: (data: ReadyEventData) => void;
  readySupplemental: (data: ReadySupplementalData) => void;
  guildCreate: (data: GuildCreateData) => void;
  voiceStateUpdate: (data: VoiceState) => void;
  messageCreate: (data: MessageCreateData) => void;
  streamCreate: (data: StreamCreateData) => void;
  streamDelete: (data: StreamDeleteData) => void;
}

export interface GatewayClient {
  on<U extends keyof GatewayClientEvents>(event: U, listener: GatewayClientEvents[U]): this;
  once<U extends keyof GatewayClientEvents>(event: U, listener: GatewayClientEvents[U]): this;
  emit<U extends keyof GatewayClientEvents>(event: U, ...args: Parameters<GatewayClientEvents[U]>): boolean;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: BotConfig;
  private readonly heartbeat: HeartbeatManager;
  private lastSequence: number | null = null;
  private isIntentionalClose: boolean = false;

  // Gateway send rate-limiting: max 120 commands per 60 seconds
  private readonly sendTimestamps: number[] = [];
  private readonly GATEWAY_RATE_LIMIT = 120;
  private readonly GATEWAY_RATE_WINDOW_MS = 60000;

  constructor(config: BotConfig) {
    super();
    this.config = config;

    const sender: HeartbeatSender = {
      send: (data: string) => this.sendRaw(data),
      getSequence: () => this.lastSequence,
    };

    const handleZombieConnection = () => {
      logger.error('Zombie connection detected (missed heartbeat ACK). Exiting for fresh restart...');
      process.exit(1);
    };

    this.heartbeat = new HeartbeatManager(sender, handleZombieConnection);
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public connect(): void {
    if (!this.config.token) {
      logger.error('Missing TOKEN environment variable.');
      process.exit(1);
    }

    this.isIntentionalClose = false;
    logger.info('Connecting to Discord Gateway...');

    try {
      this.ws = new WebSocket(DISCORD_GATEWAY.DEFAULT_URL, {
        headers: {
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
      });

      this.ws.on('open', () => {
        logger.info('WebSocket connected.');
      });

      this.ws.on('message', (rawData: WebSocket.RawData) => {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
        this.handleMessage(text);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.heartbeat.stop();
        const reasonStr = reason.toString('utf-8');

        if (this.isIntentionalClose) {
          logger.info(`WebSocket closed intentionally (code: ${code}).`);
          return;
        }

        logger.error(`WebSocket closed unexpectedly (code: ${code}, reason: "${reasonStr || 'none'}"). Exiting for fresh restart...`);
        process.exit(1);
      });

      this.ws.on('error', (error: Error) => {
        this.heartbeat.stop();
        logger.error(`WebSocket transport error: ${error.message}. Exiting for fresh restart...`);
        process.exit(1);
      });
    } catch (error) {
      logger.error(`Connection failed: ${(error as Error).message}. Exiting...`);
      process.exit(1);
    }
  }

  public sendRaw(payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Enforce gateway rate limiting (120 sends / 60 seconds)
    const now = Date.now();
    while (this.sendTimestamps.length > 0 && this.sendTimestamps[0]! < now - this.GATEWAY_RATE_WINDOW_MS) {
      this.sendTimestamps.shift();
    }

    if (this.sendTimestamps.length >= this.GATEWAY_RATE_LIMIT) {
      logger.warn(`Gateway send rate limit hit (${this.sendTimestamps.length}/120 in 60s). Throttling payload.`);
      return;
    }

    this.sendTimestamps.push(now);
    this.ws.send(payload);
  }

  public sendOp(op: number, d: unknown): void {
    this.sendRaw(JSON.stringify({ op, d }));
  }

  public disconnect(): void {
    this.isIntentionalClose = true;
    this.heartbeat.stop();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private handleMessage(rawMessage: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const { op, d, s, t } = payload;

    if (s !== null && s !== undefined) {
      this.lastSequence = s;
    }

    switch (op) {
      case GATEWAY_OPCODES.HELLO: {
        const hello = d as HelloData;
        this.heartbeat.start(hello.heartbeat_interval);

        logger.info('Sending IDENTIFY...');
        this.sendOp(GATEWAY_OPCODES.IDENTIFY, {
          token: this.config.token,
          properties: DISCORD_CLIENT_PROPERTIES,
          presence: {
            status: this.config.status,
            afk: false,
            activities: [],
            since: 0,
          },
          intents: DISCORD_GATEWAY.INTENTS,
        });
        break;
      }

      case GATEWAY_OPCODES.HEARTBEAT_ACK: {
        this.heartbeat.acknowledge();
        break;
      }

      case GATEWAY_OPCODES.HEARTBEAT: {
        logger.debug('Gateway requested heartbeat (OP 1)');
        this.heartbeat.sendHeartbeat();
        break;
      }

      case GATEWAY_OPCODES.RECONNECT: {
        logger.error('Gateway requested reconnect (OP 7). Exiting for fresh restart...');
        process.exit(1);
        break;
      }

      case GATEWAY_OPCODES.INVALID_SESSION: {
        logger.error('Invalid session (OP 9). Exiting for fresh restart...');
        process.exit(1);
        break;
      }

      case GATEWAY_OPCODES.DISPATCH: {
        this.handleDispatch(t, d);
        break;
      }

      default:
        break;
    }
  }

  private handleDispatch(eventType: string | null, data: unknown): void {
    switch (eventType) {
      case 'READY': {
        const readyData = data as ReadyEventData;
        logger.success(`Authenticated as ${readyData.user.username}`);
        this.emit('ready', readyData);
        break;
      }

      case 'READY_SUPPLEMENTAL': {
        this.emit('readySupplemental', data as ReadySupplementalData);
        break;
      }

      case 'GUILD_CREATE': {
        this.emit('guildCreate', data as GuildCreateData);
        break;
      }

      case 'VOICE_STATE_UPDATE': {
        this.emit('voiceStateUpdate', data as VoiceState);
        break;
      }

      case 'MESSAGE_CREATE': {
        this.emit('messageCreate', data as MessageCreateData);
        break;
      }

      case 'STREAM_CREATE': {
        this.emit('streamCreate', data as StreamCreateData);
        break;
      }

      case 'STREAM_DELETE': {
        this.emit('streamDelete', data as StreamDeleteData);
        break;
      }

      default:
        break;
    }
  }
}
