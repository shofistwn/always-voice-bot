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
  private activeHost: string;
  private activePort: number;

  constructor(config: MusicConfig) {
    super();
    this.config = config;
    this.activeHost = config.nodelinkHost;
    this.activePort = config.nodelinkPort;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  public getRestBaseUrl(): string {
    const protocol = this.config.nodelinkSecure ? 'https' : 'http';
    return `${protocol}://${this.activeHost}:${this.activePort}/v4`;
  }

  public getWsUrl(): string {
    const protocol = this.config.nodelinkSecure ? 'wss' : 'ws';
    return `${protocol}://${this.activeHost}:${this.activePort}/v4/websocket`;
  }

  public start(botUserId: string): void {
    if (this.isDestroyed) return;
    this.botUserId = botUserId;
    this.connectWs();
  }

  private connectWs(): void {
    if (!this.botUserId || this.isDestroyed) return;

    const wsUrl = this.getWsUrl();
    logger.info(`Connecting to NodeLink server at ${this.activeHost}:${this.activePort}...`);

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
        if (this.activeHost === 'nodelink' && err.message.includes('ENOTFOUND nodelink')) {
          logger.warn('Host "nodelink" not resolvable on host system. Falling back to "localhost"...');
          this.activeHost = 'localhost';
          return;
        }

        if (this.activePort === 2333 && (err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED'))) {
          logger.warn('Port 2333 connection failed. Falling back to default NodeLink port 3000...');
          this.activePort = 3000;
          return;
        }

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

  /**
   * Resolves and normalizes query or URL to appropriate NodeLink source:
   * 1. If a YouTube / Shorts / youtu.be URL is provided:
   *    - Automatically redirected/normalized to YouTube Music domain (https://music.youtube.com/...)
   * 2. If a Spotify URL is provided:
   *    - Strips tracking parameters (si/context)
   * 3. If a search keyword / prefix is provided (yt, ytsearch, ytm, sp, etc.):
   *    - YouTube searches are routed to YouTube Music (ytmsearch:)
   * 4. If plain query without URL or prefix:
   *    - Defaults to YouTube Music search (ytmsearch:<query>)
   */
  public resolveIdentifier(input: string): string {
    const raw = input.trim();
    if (!raw) return raw;

    // 1. Keyword prefix mapping (all YouTube queries routed to YouTube Music)
    const prefixMap: Record<string, string> = {
      ytm: 'ytmsearch:',
      ytmusic: 'ytmsearch:',
      ytmsearch: 'ytmsearch:',
      yt: 'ytmsearch:',
      ytsearch: 'ytmsearch:',
      sp: 'spsearch:',
      spotify: 'spsearch:',
      spsearch: 'spsearch:',
    };

    const prefixMatch = raw.match(/^([a-z0-9_-]+):(.*)$/i);
    if (prefixMatch) {
      const prefix = prefixMatch[1].toLowerCase();
      const rest = prefixMatch[2].trim();
      if (prefixMap[prefix]) {
        return `${prefixMap[prefix]}${rest}`;
      }
      if (prefix !== 'http' && prefix !== 'https') {
        return raw;
      }
    }

    // 2. URL detection (YouTube & Spotify)
    const isExplicitUrl = /^https?:\/\//i.test(raw);
    const domainPattern = /^(?:[a-z0-9-]+\.)?(?:youtube\.com|youtu\.be|spotify\.com|spotify\.link)(\/.*)?$/i;
    const isUrlLike = isExplicitUrl || domainPattern.test(raw);

    if (isUrlLike) {
      const urlString = isExplicitUrl ? raw : `https://${raw}`;
      try {
        const parsed = new URL(urlString);
        const host = parsed.hostname.toLowerCase();

        // A. All YouTube / youtu.be / Shorts links are redirected directly to YouTube Music
        if (host.includes('youtube.com') || host.includes('youtu.be')) {
          const videoId = parsed.searchParams.get('v');
          const listId = parsed.searchParams.get('list');

          // Normalize youtu.be/<id> -> music.youtube.com/watch?v=<id>
          if (host.includes('youtu.be')) {
            const id = parsed.pathname.replace(/^\//, '').split('/')[0];
            if (id) {
              const newUrl = new URL('https://music.youtube.com/watch');
              newUrl.searchParams.set('v', id);
              if (listId) newUrl.searchParams.set('list', listId);
              return newUrl.toString();
            }
          }

          // Normalize youtube.com/shorts/<id> -> music.youtube.com/watch?v=<id>
          if (parsed.pathname.startsWith('/shorts/')) {
            const id = parsed.pathname.replace(/^\/shorts\//, '').split('/')[0];
            if (id) {
              const newUrl = new URL('https://music.youtube.com/watch');
              newUrl.searchParams.set('v', id);
              if (listId) newUrl.searchParams.set('list', listId);
              return newUrl.toString();
            }
          }

          // Pure playlist -> music.youtube.com/playlist?list=<id>
          if (!videoId && listId) {
            const cleanUrl = new URL('https://music.youtube.com/playlist');
            cleanUrl.searchParams.set('list', listId);
            return cleanUrl.toString();
          }

          // Video watch -> music.youtube.com/watch?v=<id>
          if (videoId) {
            const cleanUrl = new URL('https://music.youtube.com/watch');
            cleanUrl.searchParams.set('v', videoId);
            if (listId) cleanUrl.searchParams.set('list', listId);
            return cleanUrl.toString();
          }

          // Fallback other youtube.com domains to host music.youtube.com
          const fallbackUrl = new URL(urlString);
          fallbackUrl.protocol = 'https:';
          fallbackUrl.host = 'music.youtube.com';
          return fallbackUrl.toString();
        }

        // B. Spotify
        if (host.includes('spotify.com') || host.includes('spotify.link')) {
          parsed.searchParams.delete('si');
          parsed.searchParams.delete('context');
          return parsed.toString();
        }

        return urlString;
      } catch {
        // Fallback if URL parsing fails
      }
    }

    // 3. Without URL and without keyword prefix -> default search on YouTube Music
    return `ytmsearch:${raw}`;
  }

  private async resolveSpotifyFallback(url: string): Promise<string | null> {
    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = (await res.json()) as { title?: string };
        if (data.title) {
          return `ytmsearch:${data.title}`;
        }
      }
    } catch {
      // Ignore on error
    }
    return null;
  }

  public async loadTracks(identifier: string): Promise<NodeLinkLoadResult> {
    const target = this.resolveIdentifier(identifier);
    const url = `${this.getRestBaseUrl()}/loadtracks?identifier=${encodeURIComponent(target)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.config.nodelinkPassword,
      },
    });

    if (!res.ok) {
      throw new Error(`NodeLink REST error ${res.status}: ${res.statusText}`);
    }

    const result = (await res.json()) as NodeLinkLoadResult;

    // Resilient fallback if NodeLink has no Spotify API key or fails to resolve Spotify link
    if (
      (result.loadType === 'empty' || result.loadType === 'error') &&
      /spotify\.(com|link)/i.test(target)
    ) {
      const fallbackQuery = await this.resolveSpotifyFallback(target);
      if (fallbackQuery) {
        logger.info(`Spotify fallback via YouTube Music: "${fallbackQuery}"`);
        return this.loadTracks(fallbackQuery);
      }
    }

    return result;
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
