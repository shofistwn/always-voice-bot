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
} from '../types/discord.js';
import { GATEWAY_OPCODES, DISCORD_GATEWAY } from '../constants/discord.js';
import { GatewaySession } from './session.js';
import { HeartbeatManager, type HeartbeatSender } from './heartbeat.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Gateway');

export interface GatewayClientEvents {
  ready: (data: ReadyEventData) => void;
  resumed: (sequence: number | null) => void;
  guildCreate: (data: GuildCreateData) => void;
  voiceStateUpdate: (data: VoiceState) => void;
  messageCreate: (data: MessageCreateData) => void;
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: BotConfig;
  private readonly session: GatewaySession;
  private readonly heartbeat: HeartbeatManager;
  private isIntentionalClose: boolean = false;

  constructor(config: BotConfig, session?: GatewaySession) {
    super();
    this.config = config;
    this.session = session ?? new GatewaySession();

    const sender: HeartbeatSender = {
      send: (data: string) => this.sendRaw(data),
      getSequence: () => this.session.getSequence(),
    };

    const handleZombieConnection = () => {
      logger.error('Zombie connection detected (dead socket). Triggering fail-fast exit...');
      process.exit(1);
    };

    this.heartbeat = new HeartbeatManager(sender, handleZombieConnection);
  }

  public getSession(): GatewaySession {
    return this.session;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public connect(): void {
    if (!this.config.token) {
      logger.error('No token provided. Please set the TOKEN environment variable.');
      process.exit(1);
    }

    const attemptingResume = this.session.canResume();
    let gatewayUrl: string;

    if (attemptingResume) {
      gatewayUrl = `${this.session.getResumeGatewayUrl()}?v=10&encoding=json`;
      logger.info(`Connecting to resume endpoint (${this.session.getResumeGatewayUrl()})...`);
    } else {
      gatewayUrl = DISCORD_GATEWAY.DEFAULT_URL;
      logger.info('Connecting to Discord Gateway (v10)...');
    }

    try {
      this.ws = new WebSocket(gatewayUrl, {
        headers: {
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
      });

      this.ws.on('open', () => {
        logger.info('WebSocket connection established.');
      });

      this.ws.on('message', (rawData: WebSocket.RawData) => {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
        this.handleMessage(text);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.heartbeat.stop();
        if (this.isIntentionalClose) {
          logger.info(`WebSocket closed cleanly (code: ${code}).`);
          return;
        }
        logger.error(
          `WebSocket connection dropped unexpectedly (code: ${code}, reason: "${reason.toString() || 'none'}"). Crashing for Docker recovery...`
        );
        process.exit(1);
      });

      this.ws.on('error', (error: Error) => {
        this.heartbeat.stop();
        logger.error(`WebSocket socket error: ${error.message}. Crashing for Docker recovery...`);
        process.exit(1);
      });
    } catch (error) {
      logger.error(`Failed to initiate connection: ${(error as Error).message}. Crashing...`);
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
      this.session.setSequence(s);
    }

    switch (op) {
      case GATEWAY_OPCODES.HELLO: {
        const hello = d as HelloData;
        this.heartbeat.start(hello.heartbeat_interval);

        if (this.session.canResume()) {
          const sid = this.session.getSessionId();
          logger.info(`Sending RESUME payload (session: ${sid ? sid.slice(0, 8) + '...' : 'unknown'}, seq: ${this.session.getSequence()})`);
          this.sendOp(GATEWAY_OPCODES.RESUME, {
            token: this.config.token,
            session_id: sid,
            seq: this.session.getSequence(),
          });
        } else {
          logger.info('Sending IDENTIFY payload for initial session...');
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
        }
        break;
      }

      case GATEWAY_OPCODES.HEARTBEAT_ACK: {
        this.heartbeat.acknowledge();
        break;
      }

      case GATEWAY_OPCODES.HEARTBEAT: {
        logger.debug('Gateway requested immediate heartbeat (OP 1)');
        this.heartbeat.sendHeartbeat();
        break;
      }

      case GATEWAY_OPCODES.RECONNECT: {
        logger.error('Gateway requested reconnection (OP 7). Exiting for restart...');
        process.exit(1);
        break;
      }

      case GATEWAY_OPCODES.INVALID_SESSION: {
        logger.error('Invalid session reported by Gateway (OP 9). Resetting cache and exiting for restart...');
        this.session.reset();
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
        this.session.setSession(readyData.session_id, readyData.resume_gateway_url);
        logger.success(`Authenticated as ${readyData.user.username} (ID: ${readyData.user.id}, Session: ${readyData.session_id.slice(0, 8)}...)`);
        this.emit('ready', readyData);
        break;
      }

      case 'RESUMED': {
        logger.success(`Session resumed successfully (sequence: ${this.session.getSequence() ?? 0})`);
        this.emit('resumed', this.session.getSequence());
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

      default:
        break;
    }
  }
}
