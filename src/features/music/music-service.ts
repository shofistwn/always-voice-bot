import type { BotConfig } from '../../types/config.js';
import type {
  MessageCreateData,
  VoiceServerUpdateData,
  VoiceState,
} from '../../types/discord.js';
import type {
  NodeLinkLoadResult,
  NodeLinkPlaylistData,
  NodeLinkTrack,
  NodeLinkVoiceUpdate,
} from '../../types/nodelink.js';
import type { VoiceManager } from '../../voice/voice-manager.js';
import type { EntityCache } from '../../cache/entity-cache.js';
import { DISCORD_GATEWAY } from '../../constants/discord.js';
import { NodeLinkClient } from './nodelink-client.js';
import { createLogger } from '../../logger/index.js';

const logger = createLogger('Music');

function formatDuration(ms: number): string {
  if (ms <= 0 || !Number.isFinite(ms)) return 'Live';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}:${String(remainingMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export class MusicService {
  private readonly config: BotConfig;
  private readonly client: NodeLinkClient;
  private readonly voiceManager: VoiceManager;
  private readonly cache?: EntityCache;

  private voiceSessionId: string | null = null;
  private voiceServerData: VoiceServerUpdateData | null = null;
  private queue: NodeLinkTrack[] = [];
  private currentTrack: NodeLinkTrack | null = null;
  private isPaused: boolean = false;
  private volume: number = 100;
  private isVoiceConnectedToNode: boolean = false;

  constructor(config: BotConfig, voiceManager: VoiceManager, cache?: EntityCache) {
    this.config = config;
    this.voiceManager = voiceManager;
    this.cache = cache;
    this.client = new NodeLinkClient(config.music);

    this.registerNodeLinkEvents();
  }

  public start(botUserId: string): void {
    if (!this.config.music.enabled) return;
    this.client.start(botUserId);
  }

  private registerNodeLinkEvents(): void {
    this.client.on('ready', () => {
      this.syncVoiceStateToNode();
    });

    this.client.on('trackEnd', (_guildId, track, reason) => {
      logger.info(`Track ended: "${track.info.title}" (reason: ${reason})`);
      if (reason === 'finished' || reason === 'loadFailed') {
        this.playNext();
      }
    });

    this.client.on('trackStart', (_guildId, track) => {
      logger.success(`Playing: "${track.info.title}" by ${track.info.author}`);
    });

    this.client.on('trackException', (_guildId, track, error) => {
      logger.error(`Track exception for "${track.info.title}": ${error}`);
      this.playNext();
    });
  }

  public handleVoiceStateUpdate(data: VoiceState, botUserId: string | null): void {
    if (!this.config.music.enabled || !botUserId) return;

    if (data.user_id === botUserId && data.session_id) {
      this.voiceSessionId = data.session_id;
      this.syncVoiceStateToNode();
    }
  }

  public handleVoiceServerUpdate(data: VoiceServerUpdateData): void {
    if (!this.config.music.enabled) return;

    if (data.guild_id === this.config.guildId && data.endpoint) {
      this.voiceServerData = data;
      this.syncVoiceStateToNode();
    }
  }

  private syncVoiceStateToNode(): void {
    if (!this.client.isConnected() || !this.voiceSessionId || !this.voiceServerData?.endpoint) {
      return;
    }

    const voiceUpdate: NodeLinkVoiceUpdate = {
      token: this.voiceServerData.token,
      endpoint: this.voiceServerData.endpoint,
      sessionId: this.voiceSessionId,
    };

    this.client
      .updatePlayer(this.config.guildId, { voice: voiceUpdate })
      .then(() => {
        if (!this.isVoiceConnectedToNode) {
          logger.success('Voice connection linked to NodeLink server.');
          this.isVoiceConnectedToNode = true;
        }
      })
      .catch((err) => {
        logger.warn(`Failed to sync voice state to NodeLink: ${(err as Error).message}`);
      });
  }

  public async handleMessage(message: MessageCreateData, botUserId: string | null): Promise<void> {
    if (!this.config.music.enabled || !botUserId) return;
    if (message.author.id === botUserId) return;

    const raw = message.content?.trim();
    if (!raw || !raw.startsWith(this.config.music.prefix)) return;

    const body = raw.slice(this.config.music.prefix.length).trim();
    if (!body) return;

    const [command, ...args] = body.split(/\s+/);
    const cmd = command.toLowerCase();
    const query = args.join(' ');

    switch (cmd) {
      case 'play':
      case 'p':
        await this.handlePlayCommand(message.channel_id, query);
        break;

      case 'stop':
        await this.handleStopCommand(message.channel_id);
        break;

      case 'skip':
      case 's':
        await this.handleSkipCommand(message.channel_id);
        break;

      case 'pause':
        await this.handlePauseCommand(message.channel_id);
        break;

      case 'resume':
        await this.handleResumeCommand(message.channel_id);
        break;

      case 'queue':
      case 'q':
        await this.handleQueueCommand(message.channel_id);
        break;

      case 'nowplaying':
      case 'np':
        await this.handleNowPlayingCommand(message.channel_id);
        break;

      case 'volume':
      case 'vol':
        await this.handleVolumeCommand(message.channel_id, query);
        break;

      case 'help':
        await this.handleHelpCommand(message.channel_id);
        break;

      default:
        break;
    }
  }

  private async handlePlayCommand(channelId: string, query: string): Promise<void> {
    if (!query) {
      await this.sendReply(channelId, `❌ Silakan masukkan judul atau URL lagu. Contoh: \`${this.config.music.prefix}play never gonna give you up\``);
      return;
    }

    if (!this.client.isConnected()) {
      await this.sendReply(channelId, '⚠️ Server musik NodeLink belum terhubung. Coba beberapa saat lagi.');
      return;
    }

    try {
      const isUrl = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `search:${query}`;

      const result: NodeLinkLoadResult = await this.client.loadTracks(identifier);

      if (result.loadType === 'empty' || result.loadType === 'error') {
        await this.sendReply(channelId, '❌ Lagu tidak ditemukan.');
        return;
      }

      if (result.loadType === 'playlist') {
        const playlist = result.data as NodeLinkPlaylistData;
        const tracks = playlist.tracks || [];
        if (tracks.length === 0) {
          await this.sendReply(channelId, '❌ Playlist kosong.');
          return;
        }

        this.queue.push(...tracks);
        await this.sendReply(channelId, `🎶 Menambahkan **${tracks.length} lagu** dari playlist **${playlist.info.name}** ke dalam antrean.`);

        if (!this.currentTrack) {
          this.playNext();
        }
        return;
      }

      // Single track or search result
      let trackToPlay: NodeLinkTrack | null = null;
      if (result.loadType === 'track') {
        trackToPlay = result.data as NodeLinkTrack;
      } else if (result.loadType === 'search') {
        const tracks = result.data as NodeLinkTrack[];
        trackToPlay = tracks[0] ?? null;
      }

      if (!trackToPlay) {
        await this.sendReply(channelId, '❌ Lagu tidak ditemukan.');
        return;
      }

      if (!this.currentTrack) {
        this.currentTrack = trackToPlay;
        await this.startPlayback(trackToPlay);
        await this.sendReply(
          channelId,
          `▶️ Memutar: **${trackToPlay.info.title}** oleh **${trackToPlay.info.author}** [${formatDuration(trackToPlay.info.length)}]`
        );
      } else {
        this.queue.push(trackToPlay);
        await this.sendReply(
          channelId,
          `➕ Ditambahkan ke antrean (#${this.queue.length}): **${trackToPlay.info.title}** [${formatDuration(trackToPlay.info.length)}]`
        );
      }
    } catch (err) {
      logger.error(`Error handling play command: ${(err as Error).message}`);
      await this.sendReply(channelId, `❌ Gagal memuat lagu: ${(err as Error).message}`);
    }
  }

  private async startPlayback(track: NodeLinkTrack): Promise<void> {
    try {
      this.syncVoiceStateToNode();
      // Ensure bot is unmuted so voice can be heard
      this.voiceManager.setMute(false);

      await this.client.updatePlayer(this.config.guildId, {
        track: { encoded: track.encoded },
        volume: this.volume,
        paused: false,
      });
      this.isPaused = false;
    } catch (err) {
      logger.error(`Failed to start playback: ${(err as Error).message}`);
      this.playNext();
    }
  }

  private playNext(): void {
    if (this.queue.length > 0) {
      this.currentTrack = this.queue.shift()!;
      this.startPlayback(this.currentTrack);
    } else {
      this.currentTrack = null;
      this.isPaused = false;
      this.voiceManager.restoreMute();
      this.client.updatePlayer(this.config.guildId, { track: { encoded: null } }).catch(() => {});
      logger.info('Queue finished. Playback stopped.');
    }
  }

  private async handleStopCommand(channelId: string): Promise<void> {
    this.queue = [];
    this.currentTrack = null;
    this.isPaused = false;

    try {
      await this.client.updatePlayer(this.config.guildId, { track: { encoded: null } });
      this.voiceManager.restoreMute();
      await this.sendReply(channelId, '⏹️ Pemutaran dihentikan dan antrean telah dibersihkan.');
    } catch (err) {
      await this.sendReply(channelId, `❌ Gagal menghentikan pemutaran: ${(err as Error).message}`);
    }
  }

  private async handleSkipCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '⚠️ Tidak ada lagu yang sedang diputar.');
      return;
    }

    const skippedTitle = this.currentTrack.info.title;
    await this.sendReply(channelId, `⏭️ Melewati: **${skippedTitle}**`);
    this.playNext();
  }

  private async handlePauseCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '⚠️ Tidak ada lagu yang sedang diputar.');
      return;
    }

    if (this.isPaused) {
      await this.sendReply(channelId, '⚠️ Lagu sudah dalam keadaan jeda (paused).');
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: true });
      this.isPaused = true;
      await this.sendReply(channelId, '⏸️ Pemutaran dijeda.');
    } catch (err) {
      await this.sendReply(channelId, `❌ Gagal menjeda lagu: ${(err as Error).message}`);
    }
  }

  private async handleResumeCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '⚠️ Tidak ada lagu yang sedang diputar.');
      return;
    }

    if (!this.isPaused) {
      await this.sendReply(channelId, '⚠️ Lagu sedang berjalan.');
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: false });
      this.isPaused = false;
      await this.sendReply(channelId, '▶️ Pemutaran dilanjutkan.');
    } catch (err) {
      await this.sendReply(channelId, `❌ Gagal melanjutkan lagu: ${(err as Error).message}`);
    }
  }

  private async handleQueueCommand(channelId: string): Promise<void> {
    if (!this.currentTrack && this.queue.length === 0) {
      await this.sendReply(channelId, '📭 Antrean kosong.');
      return;
    }

    let msg = '📋 **Antrean Musik:**\n';
    if (this.currentTrack) {
      msg += `▶️ **Sedang Diputar:** ${this.currentTrack.info.title} [${formatDuration(this.currentTrack.info.length)}]\n`;
    }

    if (this.queue.length > 0) {
      msg += '\n**Lagu Berikutnya:**\n';
      const maxDisplay = 10;
      const displayQueue = this.queue.slice(0, maxDisplay);
      displayQueue.forEach((t, i) => {
        msg += `${i + 1}. **${t.info.title}** [${formatDuration(t.info.length)}]\n`;
      });
      if (this.queue.length > maxDisplay) {
        msg += `...dan ${this.queue.length - maxDisplay} lagu lainnya.\n`;
      }
    }

    await this.sendReply(channelId, msg);
  }

  private async handleNowPlayingCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '⚠️ Tidak ada lagu yang sedang diputar.');
      return;
    }

    const { title, author, length, uri } = this.currentTrack.info;
    const status = this.isPaused ? '⏸️ Dijeda' : '▶️ Sedang Diputar';
    let text = `${status}: **${title}** oleh **${author}**\nDurasi: [${formatDuration(length)}]`;
    if (uri) {
      text += `\nTautan: <${uri}>`;
    }

    await this.sendReply(channelId, text);
  }

  private async handleVolumeCommand(channelId: string, query: string): Promise<void> {
    const vol = parseInt(query, 10);
    if (Number.isNaN(vol) || vol < 0 || vol > 100) {
      await this.sendReply(channelId, `❌ Masukkan angka volume antara 0 - 100. Contoh: \`${this.config.music.prefix}volume 80\``);
      return;
    }

    this.volume = vol;
    try {
      await this.client.updatePlayer(this.config.guildId, { volume: vol });
      await this.sendReply(channelId, `🔊 Volume diatur ke **${vol}%**`);
    } catch (err) {
      await this.sendReply(channelId, `❌ Gagal mengatur volume: ${(err as Error).message}`);
    }
  }

  private async handleHelpCommand(channelId: string): Promise<void> {
    const p = this.config.music.prefix;
    const help = `🎵 **Daftar Perintah Musik:**\n` +
      `• \`${p}play <judul/url>\` atau \`${p}p\` — Putar lagu atau masukkan ke antrean\n` +
      `• \`${p}stop\` — Hentikan musik & bersihkan antrean\n` +
      `• \`${p}skip\` atau \`${p}s\` — Lewati lagu yang sedang diputar\n` +
      `• \`${p}pause\` — Jeda pemutaran lagu\n` +
      `• \`${p}resume\` — Lanjutkan pemutaran lagu\n` +
      `• \`${p}queue\` atau \`${p}q\` — Lihat daftar antrean lagu\n` +
      `• \`${p}nowplaying\` atau \`${p}np\` — Lihat info lagu yang sedang diputar\n` +
      `• \`${p}volume <0-100>\` — Atur volume pemutaran\n` +
      `• \`${p}help\` — Tampilkan pesan bantuan ini`;

    await this.sendReply(channelId, help);
  }

  private async sendReply(channelId: string, content: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: this.config.token,
          'Content-Type': 'application/json',
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({ content }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (err) {
      logger.warn(`Failed to send music message: ${(err as Error).message}`);
    }
  }

  public destroy(): void {
    this.client.destroy();
  }
}
