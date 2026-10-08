import EventEmitter from 'node:events';
import { WebSocket } from 'ws';
import type { MusicConfig } from '../../types/config.js';
import type {
  NodeLinkLoadResult,
  NodeLinkPlayerUpdate,
  NodeLinkTrack,
} from '../../types/nodelink.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('NodeLink');

export interface NodeLinkEvents {
  ready: (sessionId: string) => void;
  trackStart: (guildId: string, track: NodeLinkTrack) => void;
  trackEnd: (guildId: string, track: NodeLinkTrack, reason: string) => void;
  trackException: (guildId: string, track: NodeLinkTrack, error: string) => void;
}

export class NodeLinkClient extends EventEmitter {
  private readonly config: MusicConfig;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private botUserId: string | null = null;
  private isDestroyed: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: MusicConfig) {
    super();
    this.config = config;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  public getRestBaseUrl(): string {
    const protocol = this.config.nodelinkSecure ? 'https' : 'http';
    return `${protocol}://${this.config.nodelinkHost}:${this.config.nodelinkPort}/v4`;
  }

  public getWsUrl(): string {
    const protocol = this.config.nodelinkSecure ? 'wss' : 'ws';
    return `${protocol}://${this.config.nodelinkHost}:${this.config.nodelinkPort}/v4/websocket`;
  }

  public start(botUserId: string): void {
    if (this.isDestroyed) return;
    this.botUserId = botUserId;
    this.connectWs();
  }

  private connectWs(): void {
    if (!this.botUserId || this.isDestroyed) return;

    const wsUrl = this.getWsUrl();
    logger.info(`Connecting to NodeLink server at ${this.config.nodelinkHost}:${this.config.nodelinkPort}...`);

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: this.config.nodelinkPassword,
          'User-Id': this.botUserId,
          'Client-Name': 'always-voice-bot/1.0',
        },
      });

      this.ws.on('open', () => {
        logger.info('WebSocket connection opened.');
      });

      this.ws.on('message', (rawData: WebSocket.RawData) => {
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
        this.handleWsMessage(text);
      });

      this.ws.on('close', (code: number) => {
        this.sessionId = null;
        if (!this.isDestroyed) {
          logger.warn(`Connection closed (code: ${code}). Retrying in 5s...`);
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err: Error) => {
        logger.error(`Connection error: ${err.message}`);
      });
    } catch (error) {
      logger.error(`Failed to initiate connection: ${(error as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isDestroyed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, 5000);
  }

  private handleWsMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw);
      if (payload.op === 'ready') {
        this.sessionId = payload.sessionId;
        logger.success(`Ready (sessionId: ${this.sessionId})`);
        this.emit('ready', this.sessionId);
      } else if (payload.op === 'event') {
        const { type, guildId, track, reason, exception } = payload;
        if (type === 'TrackStartEvent') {
          this.emit('trackStart', guildId, track);
        } else if (type === 'TrackEndEvent') {
          this.emit('trackEnd', guildId, track, reason || 'finished');
        } else if (type === 'TrackExceptionEvent') {
          this.emit('trackException', guildId, track, exception?.message || 'Unknown error');
        }
      }
    } catch (err) {
      logger.warn(`Failed to parse WebSocket message: ${(err as Error).message}`);
    }
  }

  public async loadTracks(identifier: string): Promise<NodeLinkLoadResult> {
    const url = `${this.getRestBaseUrl()}/loadtracks?identifier=${encodeURIComponent(identifier)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.config.nodelinkPassword,
      },
    });

    if (!res.ok) {
      throw new Error(`NodeLink REST error ${res.status}: ${res.statusText}`);
    }

    return (await res.json()) as NodeLinkLoadResult;
  }

  public async updatePlayer(guildId: string, data: NodeLinkPlayerUpdate): Promise<void> {
    if (!this.sessionId) {
      throw new Error('NodeLink session not established');
    }

    const url = `${this.getRestBaseUrl()}/sessions/${this.sessionId}/players/${guildId}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: this.config.nodelinkPassword,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      throw new Error(`Failed to update player: ${res.status} ${res.statusText}`);
    }
  }

  public async destroyPlayer(guildId: string): Promise<void> {
    if (!this.sessionId) return;

    try {
      const url = `${this.getRestBaseUrl()}/sessions/${this.sessionId}/players/${guildId}`;
      await fetch(url, {
        method: 'DELETE',
        headers: {
          Authorization: this.config.nodelinkPassword,
        },
      });
    } catch {
      // Ignored
    }
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.removeAllListeners();
  }
}
