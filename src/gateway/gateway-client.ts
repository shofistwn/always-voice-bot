import EventEmitter from 'node:events';
import { WebSocket } from 'ws';
import type { BotConfig } from '../types/config.js';
import type {
  GatewayPayload,
  HelloData,
  ReadyEventData,
  GuildCreateData,
  VoiceState,
  MessageCreateData,
  StreamCreateData,
  StreamDeleteData,
} from '../types/discord.js';
import { GATEWAY_OPCODES, DISCORD_GATEWAY } from '../constants/discord.js';
import { HeartbeatManager, type HeartbeatSender } from './heartbeat.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Gateway');

export interface GatewayClientEvents {
  ready: (data: ReadyEventData) => void;
  guildCreate: (data: GuildCreateData) => void;
  voiceStateUpdate: (data: VoiceState) => void;
  messageCreate: (data: MessageCreateData) => void;
  streamCreate: (data: StreamCreateData) => void;
  streamDelete: (data: StreamDeleteData) => void;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: BotConfig;
  private readonly heartbeat: HeartbeatManager;
  private lastSequence: number | null = null;
  private isIntentionalClose: boolean = false;

  constructor(config: BotConfig) {
    super();
    this.config = config;

    const sender: HeartbeatSender = {
      send: (data: string) => this.sendRaw(data),
      getSequence: () => this.lastSequence,
    };

    const handleZombieConnection = () => {
      logger.error('Zombie connection detected. Restarting...');
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

      this.ws.on('close', (code: number) => {
        this.heartbeat.stop();
        if (this.isIntentionalClose) {
          logger.info(`WebSocket closed (code: ${code}).`);
          return;
        }
        logger.error(`WebSocket closed unexpectedly (code: ${code}).`);
        process.exit(1);
      });

      this.ws.on('error', (error: Error) => {
        this.heartbeat.stop();
        logger.error(`WebSocket error: ${error.message}`);
        process.exit(1);
      });
    } catch (error) {
      logger.error(`Connection failed: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  public sendRaw(payload: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    }
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
          properties: {
            $os: 'Windows',
            $browser: 'Chrome',
            $device: 'PC',
          },
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
        logger.error('Gateway requested reconnect (OP 7).');
        process.exit(1);
        break;
      }

      case GATEWAY_OPCODES.INVALID_SESSION: {
        logger.error('Invalid session (OP 9).');
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
