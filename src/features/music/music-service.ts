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

interface PendingSearch {
  userId: string;
  channelId: string;
  messageId?: string | null;
  tracks: NodeLinkTrack[];
  timeout: NodeJS.Timeout;
}

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

function formatTrackLink(title: string, uri?: string): string {
  if (uri && uri.startsWith('http')) {
    return `[${title}](<${uri}>)`;
  }
  return title;
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
  private lastTrack: NodeLinkTrack | null = null;
  private isPaused: boolean = false;
  private isAutoplay: boolean = false;
  private volume: number = 100;
  private isVoiceConnectedToNode: boolean = false;
  private lastChannelId: string | null = null;
  private readonly playedHistory: Set<string> = new Set();
  private readonly pendingSearches: Map<string, PendingSearch> = new Map();

  constructor(config: BotConfig, voiceManager: VoiceManager, cache?: EntityCache) {
    this.config = config;
    this.voiceManager = voiceManager;
    this.cache = cache;
    this.client = new NodeLinkClient(config.music);

    if (this.config.music.allowedUserIds.length > 0) {
      logger.info(
        `Music commands restricted to ${this.config.music.allowedUserIds.length} user(s): [${this.config.music.allowedUserIds.join(', ')}]`
      );
    } else {
      logger.info('Music commands open to all server members in the same voice channel.');
    }

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

  private isUserAllowed(userId: string): boolean {
    const allowed = this.config.music.allowedUserIds;
    if (allowed.length === 0) return true;
    return allowed.includes(userId);
  }

  private isUserInSameVoice(userId: string): boolean {
    return this.voiceManager.isUserInSameVoice(userId);
  }

  private getVoiceWarningMessage(userId: string): string {
    const botChannelId = this.voiceManager.getCurrentBotChannelId();
    if (!botChannelId) {
      return '> ### ⚠️ Perhatian\n> Bot sedang tidak berada di voice channel mana pun.';
    }

    const userChannelId = this.voiceManager.getUserVoiceChannelId(userId);
    const botChannelName = this.cache?.getChannelName(botChannelId) ?? 'voice channel bot';

    if (!userChannelId) {
      return `> ### ⚠️ Perhatian\n> Anda harus bergabung ke voice channel bot (${botChannelName}) untuk menggunakan perintah musik.`;
    }

    return `> ### ⚠️ Perhatian\n> Anda harus berada di voice channel yang sama dengan bot (${botChannelName}) untuk menggunakan perintah musik.`;
  }

  public async handleMessage(message: MessageCreateData, botUserId: string | null): Promise<void> {
    if (!this.config.music.enabled || !botUserId) return;
    if (message.author.id === botUserId) return;

    let raw = message.content?.trim() || '';
    if (!raw) return;

    // Check if this message resolves an active pending search from this user in this channel
    const searchKey = `${message.channel_id}:${message.author.id}`;
    const pendingSearch = this.pendingSearches.get(searchKey);
    if (pendingSearch) {
      const lower = raw.toLowerCase().trim();
      if (lower === 'cancel' || lower === 'batal') {
        clearTimeout(pendingSearch.timeout);
        this.pendingSearches.delete(searchKey);
        if (pendingSearch.messageId) {
          await this.deleteMessage(message.channel_id, pendingSearch.messageId);
        }
        return;
      }

      const num = parseInt(lower, 10);
      if (!Number.isNaN(num) && String(num) === lower) {
        if (!this.isUserAllowed(message.author.id)) {
          return;
        }

        if (!this.isUserInSameVoice(message.author.id)) {
          await this.sendReply(message.channel_id, this.getVoiceWarningMessage(message.author.id));
          return;
        }

        if (num >= 1 && num <= pendingSearch.tracks.length) {
          clearTimeout(pendingSearch.timeout);
          this.pendingSearches.delete(searchKey);
          if (pendingSearch.messageId) {
            await this.deleteMessage(message.channel_id, pendingSearch.messageId);
          }
          const selectedTrack = pendingSearch.tracks[num - 1];
          if (selectedTrack) {
            await this.enqueueOrPlayTrack(message.channel_id, selectedTrack);
          }
        } else {
          await this.sendReply(
            message.channel_id,
            `> ### ⚠️ Pilihan Tidak Valid\n> Masukkan angka antara 1 hingga ${pendingSearch.tracks.length}.`
          );
        }
        return;
      }
    }

    // Check if bot was mentioned
    const isMentioned = message.mentions.some((m) => m.id === botUserId);
    const mentionRegex = new RegExp(`^<@!?${botUserId}>\\s*`, 'i');
    const hasMentionPrefix = mentionRegex.test(raw);

    if (hasMentionPrefix) {
      raw = raw.replace(mentionRegex, '').trim();
    }

    const prefix = this.config.music.prefix;
    let isCommand = false;

    if (raw.startsWith(prefix)) {
      raw = raw.slice(prefix.length).trim();
      isCommand = true;
    } else if (isMentioned || hasMentionPrefix) {
      isCommand = true;
    }

    if (!isCommand || !raw) return;

    const [command, ...args] = raw.split(/\s+/);
    const cmd = command.toLowerCase();
    const query = args.join(' ');

    const knownCommands = [
      'play', 'p',
      'search', 'find',
      'remove', 'rm', 'del',
      'undo',
      'stop',
      'skip', 's',
      'pause',
      'resume',
      'queue', 'q',
      'nowplaying', 'np',
      'volume', 'vol',
      'autoplay', 'ap',
      'help',
    ];

    if (!knownCommands.includes(cmd)) return;

    // 1. Verify user whitelist permissions (silently ignore unauthorized users)
    if (!this.isUserAllowed(message.author.id)) {
      return;
    }

    // 2. Verify user is in the same voice channel with the bot (except for help)
    if (cmd !== 'help' && !this.isUserInSameVoice(message.author.id)) {
      await this.sendReply(message.channel_id, this.getVoiceWarningMessage(message.author.id));
      return;
    }

    this.lastChannelId = message.channel_id;
    logger.info(`Command received: "${cmd}" from ${message.author.username}`);

    switch (cmd) {
      case 'play':
      case 'p':
        await this.handlePlayCommand(message.channel_id, query);
        break;

      case 'search':
      case 'find':
        await this.handleSearchCommand(message.channel_id, message.author.id, query);
        break;

      case 'remove':
      case 'rm':
      case 'del':
        await this.handleRemoveCommand(message.channel_id, query);
        break;

      case 'undo':
        await this.handleUndoCommand(message.channel_id);
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

      case 'autoplay':
      case 'ap':
        await this.handleAutoplayCommand(message.channel_id);
        break;

      case 'help':
        await this.handleHelpCommand(message.channel_id);
        break;

      default:
        break;
    }
  }

  private async enqueueOrPlayTrack(channelId: string, track: NodeLinkTrack): Promise<void> {
    const durationStr = formatDuration(track.info.length);
    const trackTitle = formatTrackLink(track.info.title, track.info.uri);

    if (!this.currentTrack) {
      this.currentTrack = track;
      await this.startPlayback(track);
      await this.sendReply(
        channelId,
        `> ### 🎶 Sekarang Memutar\n` +
        `> **${trackTitle}**\n` +
        `> 👤 \`${track.info.author}\` • ⏱️ \`${durationStr}\``
      );
    } else {
      this.queue.push(track);
      await this.sendReply(
        channelId,
        `> ### 📥 Ditambahkan ke Antrean\n` +
        `> **${trackTitle}**\n` +
        `> 👤 \`${track.info.author}\` • ⏱️ \`${durationStr}\` • Urutan \`#${this.queue.length}\``
      );
    }
  }

  private async handlePlayCommand(channelId: string, query: string): Promise<void> {
    if (!query) {
      await this.sendReply(
        channelId,
        `> ### ⚠️ Perhatian\n> Masukkan judul atau tautan lagu.\n> Contoh: \`${this.config.music.prefix}play suket teki didi\``
      );
      return;
    }

    if (!this.client.isConnected()) {
      await this.sendReply(
        channelId,
        '> ### ⚠️ Koneksi\n> Server audio NodeLink belum siap, silakan coba beberapa saat lagi.'
      );
      return;
    }

    try {
      const isUrl = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `search:${query}`;

      logger.info(`Searching track via NodeLink: "${identifier}"...`);
      const result: NodeLinkLoadResult = await this.client.loadTracks(identifier);

      if (result.loadType === 'empty' || result.loadType === 'error') {
        logger.warn(`Search returned no results (loadType: ${result.loadType})`);
        await this.sendReply(channelId, '> ### ❌ Tidak Ditemukan\n> Lagu atau playlist tidak ditemukan.');
        return;
      }

      let trackToPlay: NodeLinkTrack | null = null;

      if (result.loadType === 'playlist') {
        const playlist = result.data as NodeLinkPlaylistData;
        const tracks = playlist.tracks || [];
        if (tracks.length === 0) {
          await this.sendReply(channelId, '> ### ❌ Kosong\n> Playlist tidak memuat lagu.');
          return;
        }

        const isRealPlaylist =
          isUrl &&
          /(playlist|album|sets|list=)/i.test(query) &&
          !playlist.info.name.toLowerCase().includes('search results');

        if (isRealPlaylist) {
          this.queue.push(...tracks);
          await this.sendReply(
            channelId,
            `> ### 📁 Playlist Ditambahkan\n` +
            `> **${playlist.info.name}**\n` +
            `> 📊 Memuat **${tracks.length}** lagu ke dalam antrean.`
          );

          if (!this.currentTrack) {
            await this.playNext();
          }
          return;
        }

        // Search results wrapped in playlist container -> pick top result
        trackToPlay = tracks[0] ?? null;
      } else if (result.loadType === 'track') {
        trackToPlay = result.data as NodeLinkTrack;
      } else if (result.loadType === 'search') {
        const tracks = Array.isArray(result.data) ? (result.data as NodeLinkTrack[]) : [];
        trackToPlay = tracks[0] ?? null;
      }

      if (!trackToPlay) {
        await this.sendReply(channelId, '> ### ❌ Tidak Ditemukan\n> Lagu tidak ditemukan.');
        return;
      }

      await this.enqueueOrPlayTrack(channelId, trackToPlay);
    } catch (err) {
      logger.error(`Error handling play command: ${(err as Error).message}`);
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleSearchCommand(
    channelId: string,
    authorId: string,
    query: string
  ): Promise<void> {
    if (!query) {
      await this.sendReply(
        channelId,
        `> ### ⚠️ Perhatian\n> Masukkan kata kunci pencarian lagu.\n> Contoh: \`${this.config.music.prefix}search suket teki didi\``
      );
      return;
    }

    if (!this.client.isConnected()) {
      await this.sendReply(
        channelId,
        '> ### ⚠️ Koneksi\n> Server audio NodeLink belum siap, silakan coba beberapa saat lagi.'
      );
      return;
    }

    try {
      const isUrl = /^https?:\/\//i.test(query);
      const identifier = isUrl ? query : `search:${query}`;

      logger.info(`Searching tracks interactively: "${identifier}"...`);
      const result: NodeLinkLoadResult = await this.client.loadTracks(identifier);

      if (result.loadType === 'empty' || result.loadType === 'error') {
        logger.warn(`Interactive search returned no results (loadType: ${result.loadType})`);
        await this.sendReply(channelId, '> ### ❌ Tidak Ditemukan\n> Lagu tidak ditemukan.');
        return;
      }

      let tracks: NodeLinkTrack[] = [];

      if (result.loadType === 'playlist') {
        const playlist = result.data as NodeLinkPlaylistData;
        tracks = playlist.tracks || [];
      } else if (result.loadType === 'track') {
        tracks = [result.data as NodeLinkTrack];
      } else if (result.loadType === 'search') {
        tracks = Array.isArray(result.data) ? (result.data as NodeLinkTrack[]) : [];
      }

      if (tracks.length === 0) {
        await this.sendReply(channelId, '> ### ❌ Tidak Ditemukan\n> Lagu tidak ditemukan.');
        return;
      }

      const candidates = tracks.slice(0, 5);
      const searchKey = `${channelId}:${authorId}`;

      const existing = this.pendingSearches.get(searchKey);
      if (existing) {
        clearTimeout(existing.timeout);
        this.pendingSearches.delete(searchKey);
        if (existing.messageId) {
          await this.deleteMessage(channelId, existing.messageId);
        }
      }

      let msg = `> ### 🔍 Hasil Pencarian\n`;
      candidates.forEach((t, i) => {
        const title = formatTrackLink(t.info.title, t.info.uri);
        msg += `> \`${i + 1}.\` **${title}**\n> 👤 \`${t.info.author}\` • ⏱️ \`${formatDuration(t.info.length)}\`\n`;
      });
      msg += `> -# Ketik angka 1–${candidates.length} untuk memutar lagu (batal otomatis dalam 15 detik).`;

      const sentMessageId = await this.sendReply(channelId, msg);

      const timeout = setTimeout(async () => {
        const current = this.pendingSearches.get(searchKey);
        if (current) {
          this.pendingSearches.delete(searchKey);
          if (current.messageId) {
            await this.deleteMessage(channelId, current.messageId);
          }
        }
      }, 15000);

      this.pendingSearches.set(searchKey, {
        userId: authorId,
        channelId,
        messageId: sentMessageId,
        tracks: candidates,
        timeout,
      });
    } catch (err) {
      logger.error(`Error handling search command: ${(err as Error).message}`);
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleRemoveCommand(channelId: string, query: string): Promise<void> {
    if (this.queue.length === 0) {
      await this.sendReply(channelId, '> ### ⚠️ Antrean Kosong\n> Belum ada lagu dalam antrean.');
      return;
    }

    const idx = parseInt(query.trim(), 10);
    if (Number.isNaN(idx) || idx < 1 || idx > this.queue.length) {
      await this.sendReply(
        channelId,
        `> ### ⚠️ Nomor Tidak Valid\n> Masukkan nomor antrean antara 1 hingga ${this.queue.length}.\n> Contoh: \`${this.config.music.prefix}remove 1\``
      );
      return;
    }

    const removed = this.queue.splice(idx - 1, 1)[0]!;
    const durationStr = formatDuration(removed.info.length);
    const trackTitle = formatTrackLink(removed.info.title, removed.info.uri);

    await this.sendReply(
      channelId,
      `> ### 🗑️ Lagu Dihapus dari Antrean\n` +
      `> **${trackTitle}**\n` +
      `> 👤 \`${removed.info.author}\` • ⏱️ \`${durationStr}\` • Posisi \`#${idx}\`\n` +
      `> -# Sisa antrean: ${this.queue.length} lagu`
    );
  }

  private async handleUndoCommand(channelId: string): Promise<void> {
    if (this.queue.length === 0) {
      await this.sendReply(
        channelId,
        '> ### ⚠️ Antrean Kosong\n> Tidak ada lagu di antrean yang dapat dibatalkan.'
      );
      return;
    }

    const undone = this.queue.pop()!;
    const durationStr = formatDuration(undone.info.length);
    const trackTitle = formatTrackLink(undone.info.title, undone.info.uri);

    await this.sendReply(
      channelId,
      `> ### ↩️ Antrean Dibatalkan (Undo)\n` +
      `> **${trackTitle}**\n` +
      `> 👤 \`${undone.info.author}\` • ⏱️ \`${durationStr}\`\n` +
      `> -# Sisa antrean: ${this.queue.length} lagu`
    );
  }

  private async startPlayback(track: NodeLinkTrack): Promise<void> {
    try {
      this.syncVoiceStateToNode();
      // Ensure bot is unmuted so voice can be heard
      this.voiceManager.setMute(false);

      this.lastTrack = track;
      this.playedHistory.add(track.info.identifier);
      if (this.playedHistory.size > 50) {
        const first = this.playedHistory.values().next().value;
        if (first) this.playedHistory.delete(first);
      }

      await this.client.updatePlayer(this.config.guildId, {
        track: { encoded: track.encoded },
        volume: this.volume,
        paused: false,
      });
      this.isPaused = false;
    } catch (err) {
      logger.error(`Failed to start playback: ${(err as Error).message}`);
      await this.playNext();
    }
  }

  private async playNext(): Promise<void> {
    if (this.queue.length > 0) {
      this.currentTrack = this.queue.shift()!;
      if (this.lastChannelId) {
        const durationStr = formatDuration(this.currentTrack.info.length);
        const trackTitle = formatTrackLink(this.currentTrack.info.title, this.currentTrack.info.uri);
        await this.sendReply(
          this.lastChannelId,
          `> ### 🎶 Sekarang Memutar\n` +
          `> **${trackTitle}**\n` +
          `> 👤 \`${this.currentTrack.info.author}\` • ⏱️ \`${durationStr}\``
        );
      }
      await this.startPlayback(this.currentTrack);
      return;
    }

    if (this.isAutoplay && this.lastTrack) {
      const recommendation = await this.fetchRecommendation(this.lastTrack);
      if (recommendation) {
        this.currentTrack = recommendation;
        if (this.lastChannelId) {
          const durationStr = formatDuration(recommendation.info.length);
          const trackTitle = formatTrackLink(recommendation.info.title, recommendation.info.uri);
          await this.sendReply(
            this.lastChannelId,
            `> ### 📻 Autoplay Rekomendasi\n` +
            `> **${trackTitle}**\n` +
            `> 👤 \`${recommendation.info.author}\` • ⏱️ \`${durationStr}\`\n` +
            `> -# 🔄 Diputar otomatis dari rekomendasi lagu terkait`
          );
        }
        await this.startPlayback(recommendation);
        return;
      }
    }

    this.currentTrack = null;
    this.isPaused = false;
    this.voiceManager.restoreMute();
    this.client.updatePlayer(this.config.guildId, { track: { encoded: null } }).catch(() => {});
    logger.info('Queue finished. Playback stopped.');
    if (this.lastChannelId) {
      await this.sendReply(this.lastChannelId, '> ### ⏹️ Antrean Selesai\n> Seluruh antrean lagu telah selesai diputar.');
    }
  }

  private async fetchRecommendation(previousTrack: NodeLinkTrack): Promise<NodeLinkTrack | null> {
    logger.info(`Fetching autoplay recommendation for "${previousTrack.info.title}"...`);
    try {
      // 1. Try YouTube Mix radio if an identifier exists
      if (previousTrack.info.identifier) {
        const mixUrl = `https://www.youtube.com/watch?v=${previousTrack.info.identifier}&list=RD${previousTrack.info.identifier}`;
        const res = await this.client.loadTracks(mixUrl);
        if (res.loadType === 'playlist') {
          const playlist = res.data as NodeLinkPlaylistData;
          const candidate = (playlist.tracks || []).find(
            (t) => !this.playedHistory.has(t.info.identifier)
          );
          if (candidate) {
            logger.info(`Found YouTube Mix recommendation: "${candidate.info.title}"`);
            return candidate;
          }
        }
      }

      // 2. Fallback: Search related by author & title
      const searchQuery = `search:${previousTrack.info.author} ${previousTrack.info.title}`;
      const searchRes = await this.client.loadTracks(searchQuery);
      if (searchRes.loadType === 'playlist') {
        const playlist = searchRes.data as NodeLinkPlaylistData;
        const candidate = (playlist.tracks || []).find(
          (t) => !this.playedHistory.has(t.info.identifier)
        );
        if (candidate) {
          logger.info(`Found search recommendation: "${candidate.info.title}"`);
          return candidate;
        }
      } else if (searchRes.loadType === 'search') {
        const tracks = Array.isArray(searchRes.data) ? (searchRes.data as NodeLinkTrack[]) : [];
        const candidate = tracks.find((t) => !this.playedHistory.has(t.info.identifier));
        if (candidate) {
          logger.info(`Found search recommendation: "${candidate.info.title}"`);
          return candidate;
        }
      }
    } catch (err) {
      logger.warn(`Failed to fetch autoplay recommendation: ${(err as Error).message}`);
    }
    return null;
  }

  private async handleAutoplayCommand(channelId: string): Promise<void> {
    this.isAutoplay = !this.isAutoplay;
    const statusText = this.isAutoplay ? 'Diaktifkan' : 'Dinonaktifkan';
    const descText = this.isAutoplay
      ? 'Lagu rekomendasi serupa akan otomatis diputar saat antrean habis.'
      : 'Pemutaran akan berhenti setelah seluruh antrean selesai.';

    await this.sendReply(
      channelId,
      `> ### 🔁 Autoplay ${statusText}\n> *${descText}*`
    );

    // If nothing is currently playing and autoplay is turned on, trigger recommendation immediately
    if (this.isAutoplay && !this.currentTrack && this.lastTrack) {
      await this.playNext();
    }
  }

  private async handleStopCommand(channelId: string): Promise<void> {
    this.queue = [];
    this.currentTrack = null;
    this.isPaused = false;

    try {
      await this.client.updatePlayer(this.config.guildId, { track: { encoded: null } });
      this.voiceManager.restoreMute();
      await this.sendReply(channelId, '> ### ⏹️ Pemutaran Dihentikan\n> Seluruh antrean telah dibersihkan.');
    } catch (err) {
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleSkipCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Tidak ada lagu yang sedang diputar.');
      return;
    }

    const skippedTitle = formatTrackLink(this.currentTrack.info.title, this.currentTrack.info.uri);
    await this.sendReply(channelId, `> ### ⏭️ Lagu Dilewati\n> **${skippedTitle}**`);
    await this.playNext();
  }

  private async handlePauseCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Tidak ada lagu yang sedang diputar.');
      return;
    }

    if (this.isPaused) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Lagu sudah dalam keadaan jeda.');
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: true });
      this.isPaused = true;
      await this.sendReply(channelId, '> ### ⏸️ Pemutaran Dijeda\n> Lagu saat ini dijeda sementara.');
    } catch (err) {
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleResumeCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Tidak ada lagu yang sedang diputar.');
      return;
    }

    if (!this.isPaused) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Lagu sedang berjalan aktif.');
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: false });
      this.isPaused = false;
      await this.sendReply(channelId, '> ### ▶️ Pemutaran Dilanjutkan\n> Melanjutkan kembali pemutaran musik.');
    } catch (err) {
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleQueueCommand(channelId: string): Promise<void> {
    if (!this.currentTrack && this.queue.length === 0) {
      await this.sendReply(channelId, '> ### 📭 Antrean Kosong\n> Belum ada lagu di dalam antrean.');
      return;
    }

    let msg = '> ### 📋 Antrean Musik\n';
    if (this.currentTrack) {
      const currentTitle = formatTrackLink(this.currentTrack.info.title, this.currentTrack.info.uri);
      msg += `> ▶️ **Sedang Diputar:** **${currentTitle}** (\`${formatDuration(this.currentTrack.info.length)}\`)\n>\n`;
    }

    if (this.queue.length > 0) {
      msg += '> **Daftar Antrean:**\n';
      const maxDisplay = 10;
      const displayQueue = this.queue.slice(0, maxDisplay);
      displayQueue.forEach((t, i) => {
        const title = formatTrackLink(t.info.title, t.info.uri);
        msg += `> \`${String(i + 1).padStart(2, ' ')}.\` **${title}** — \`${t.info.author}\` (\`${formatDuration(t.info.length)}\`)\n`;
      });
      if (this.queue.length > maxDisplay) {
        msg += `> *...dan ${this.queue.length - maxDisplay} lagu lainnya.*\n`;
      }
      msg += '>\n';
    }

    msg += `> -# Total antrean: ${this.queue.length} lagu • Autoplay: ${this.isAutoplay ? 'Aktif' : 'Nonaktif'}`;

    await this.sendReply(channelId, msg);
  }

  private async handleNowPlayingCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, '> ### ⚠️ Perhatian\n> Tidak ada lagu yang sedang diputar saat ini.');
      return;
    }

    const { title, author, length, uri } = this.currentTrack.info;
    const statusHeader = this.isPaused ? '⏸️ Pemutaran Dijeda' : '🎶 Sekarang Memutar';
    const trackTitle = formatTrackLink(title, uri);

    const text =
      `> ### ${statusHeader}\n` +
      `> **${trackTitle}**\n` +
      `> 👤 \`${author}\` • ⏱️ \`${formatDuration(length)}\`\n` +
      `> -# Status: ${this.isPaused ? 'Dijeda' : 'Memutar'} • Autoplay: ${this.isAutoplay ? 'Aktif' : 'Nonaktif'}`;

    await this.sendReply(channelId, text);
  }

  private async handleVolumeCommand(channelId: string, query: string): Promise<void> {
    const vol = parseInt(query, 10);
    if (Number.isNaN(vol) || vol < 0 || vol > 100) {
      await this.sendReply(
        channelId,
        `> ### ⚠️ Format Salah\n> Masukkan angka volume antara 0 - 100.\n> Contoh: \`${this.config.music.prefix}volume 80\``
      );
      return;
    }

    this.volume = vol;
    try {
      await this.client.updatePlayer(this.config.guildId, { volume: vol });
      await this.sendReply(channelId, `> ### 🔊 Pengaturan Volume\n> Volume suara diatur ke \`${vol}%\``);
    } catch (err) {
      await this.sendReply(channelId, `> ### ❌ Gagal\n> ${(err as Error).message}`);
    }
  }

  private async handleHelpCommand(channelId: string): Promise<void> {
    const p = this.config.music.prefix;
    const help =
      `> ### 🎵 Panduan Perintah Musik (\`Prefix: ${p}\`)\n` +
      `> \`${p}play <judul/url>\` (alias: \`${p}p\`) — Putar lagu atau tambah ke antrean\n` +
      `> \`${p}search <judul>\` (alias: \`${p}find\`) — Cari lagu secara interaktif (pilih 1–5)\n` +
      `> \`${p}remove <nomor>\` (alias: \`${p}rm\`, \`${p}del\`) — Hapus lagu dari urutan antrean\n` +
      `> \`${p}undo\` — Hapus lagu terakhir yang dimasukkan ke antrean\n` +
      `> \`${p}autoplay\` (alias: \`${p}ap\`) — Nyalakan/matikan pemutaran rekomendasi otomatis\n` +
      `> \`${p}skip\` (alias: \`${p}s\`) — Lewati lagu yang sedang diputar\n` +
      `> \`${p}pause\` / \`${p}resume\` — Jeda atau lanjutkan pemutaran lagu\n` +
      `> \`${p}queue\` (alias: \`${p}q\`) — Tampilkan daftar antrean lagu\n` +
      `> \`${p}nowplaying\` (alias: \`${p}np\`) — Detail info lagu saat ini\n` +
      `> \`${p}volume <0-100>\` (alias: \`${p}vol\`) — Atur tingkat volume suara\n` +
      `> \`${p}stop\` — Hentikan lagu dan bersihkan seluruh antrean\n` +
      `> \`${p}help\` — Tampilkan daftar bantuan ini\n` +
      `>\n` +
      `> -# Pengguna harus berada di satu voice channel yang sama dengan bot untuk menjalankan pemutaran.`;

    await this.sendReply(channelId, help);
  }

  private async sendReply(channelId: string, content: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
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

      const channelName = this.cache?.getChannelName(channelId) ?? channelId;
      if (res.ok) {
        logger.info(`Reply sent to ${channelName}`);
        const data = (await res.json().catch(() => null)) as { id?: string } | null;
        return data?.id ?? null;
      } else {
        logger.warn(`Failed to send Discord message to ${channelName}: HTTP ${res.status} ${res.statusText}`);
        return null;
      }
    } catch (err) {
      logger.warn(`Failed to send music message: ${(err as Error).message}`);
      return null;
    }
  }

  private async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      const res = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: {
          Authorization: this.config.token,
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
      });

      if (!res.ok && res.status !== 404) {
        logger.warn(`Failed to delete message ${messageId}: HTTP ${res.status}`);
      }
    } catch (err) {
      logger.warn(`Failed to delete message: ${(err as Error).message}`);
    }
  }

  public destroy(): void {
    for (const pending of this.pendingSearches.values()) {
      clearTimeout(pending.timeout);
      if (pending.messageId) {
        this.deleteMessage(pending.channelId, pending.messageId).catch(() => {});
      }
    }
    this.pendingSearches.clear();
    this.client.destroy();
  }
}
