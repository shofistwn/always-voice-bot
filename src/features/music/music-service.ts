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

/** Escape markdown characters so special title/artist characters do not break formatting */
function escapeMarkdown(text: string): string {
  return text.replace(/([\[\]\\*_`~|>])/g, '\\$1');
}

function formatTrackLink(title: string, uri?: string): string {
  const label = escapeMarkdown(title);
  if (uri && uri.startsWith('http')) {
    return `[${label}](<${uri}>)`;
  }
  return label;
}

/** Total duration (live streams or invalid durations are skipped) */
function totalDuration(tracks: NodeLinkTrack[]): number {
  return tracks.reduce((sum, t) => {
    const len = t.info.length;
    return Number.isFinite(len) && len > 0 ? sum + len : sum;
  }, 0);
}

/** Formats " by Artist" suffix (empty if artist is unavailable) */
function byAuthor(author?: string): string {
  return author ? ` by ${escapeMarkdown(author)}` : '';
}

/** Concise single line: Title by Artist `03:45` — duration in code span separated from link */
function trackLine(track: NodeLinkTrack): string {
  const { title, uri, author, length } = track.info;
  return `${formatTrackLink(title, uri)}${byAuthor(author)} \`${formatDuration(length)}\``;
}

/** Track card (single-line blockquote): **Title** by Artist `03:45` */
function trackCard(track: NodeLinkTrack): string {
  const { title, uri, author, length } = track.info;
  return `> **${formatTrackLink(title, uri)}**${byAuthor(author)} \`${formatDuration(length)}\``;
}

/** Numbered list line: 1. Title `03:45` */
function numberedLine(index: number, track: NodeLinkTrack): string {
  return `${index}. ${trackLine(track)}`;
}

function volumeBar(volume: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(volume / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/** Discord single message length limit */
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Splits long message into chunks ≤ limit.
 * Cut priority: section breaks (empty lines) → newlines → hard character cut.
 */
function splitMessage(content: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  if (content.length <= limit) return [content];

  const chunks: string[] = [];
  let current = '';

  const push = (text: string): void => {
    if (text.trim()) chunks.push(text.trim());
  };
  const append = (piece: string, separator: string): void => {
    const candidate = current ? `${current}${separator}${piece}` : piece;
    if (candidate.length <= limit) {
      current = candidate;
      return;
    }
    push(current);
    current = piece;
  };

  for (const section of content.split('\n\n')) {
    if (section.length <= limit) {
      append(section, '\n\n');
      continue;
    }

    // Section exceeds limit: split line by line
    push(current);
    current = '';
    for (const line of section.split('\n')) {
      let rest = line;
      while (rest.length > limit) {
        push(current);
        current = '';
        push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      append(rest, '\n');
    }
  }
  push(current);

  return chunks;
}

/**
 * Reply message templates.
 * - Track status : icon **Label** + track card (blockquote)
 * - Lists        : header `##` + list + footer subtext `-#`
 */
const fmt = {
  // Track status
  playing: (t: NodeLinkTrack) => `🎶 **Sedang memutar**\n${trackCard(t)}`,
  paused: (t: NodeLinkTrack) => `⏸️ **Dijeda**\n${trackCard(t)}`,
  queued: (t: NodeLinkTrack, position: number) =>
    `📥 **Masuk antrean** \`#${position}\`\n${trackCard(t)}`,
  playlist: (name: string, count: number, totalMs: number) => {
    const meta = [`\`${count} lagu\``, totalMs > 0 ? `\`${formatDuration(totalMs)}\`` : '']
      .filter(Boolean)
      .join(' · ');
    return `📁 **Playlist ditambahkan**\n> **${escapeMarkdown(name)}**\n> ${meta}`;
  },
  skipped: (t: NodeLinkTrack) => `⏭️ **Dilewati** ${formatTrackLink(t.info.title, t.info.uri)}`,
  removed: (t: NodeLinkTrack) => `🗑️ **Dihapus** ${formatTrackLink(t.info.title, t.info.uri)}`,
  undone: (t: NodeLinkTrack) => `↩️ **Dibatalkan** ${formatTrackLink(t.info.title, t.info.uri)}`,
  jumped: (t: NodeLinkTrack, position: number) =>
    `⏭️ **Lompat ke** \`#${position}\`\n${trackCard(t)}`,

  // Warnings & errors
  warn: (text: string) => `⚠️ ${text}`,
  fail: (err: unknown) => `❌ Gagal: ${(err as Error).message}`,

  // Static messages
  notFound: '🔎 Lagu atau playlist tidak ditemukan.',
  nodeNotReady: '🔌 Server audio belum siap, coba lagi sebentar.',
  nothingPlaying: '🎧 Tidak ada lagu yang sedang diputar.',
  queueEmpty: '🗃️ Antrean kosong.',
  finished: '⏹️ **Antrean selesai**',

  // Playback controls
  stopped: '⏹️ **Dihentikan** — antrean dibersihkan',
  pausedNow: '⏸️ **Dijeda**',
  resumed: '▶️ **Dilanjutkan**',
  autoplay: (on: boolean) => `🔁 **Autoplay** \`${on ? 'aktif' : 'nonaktif'}\``,
  loop: (count: number | null) => {
    if (count === null) return '🔁 **Loop** `nonaktif`';
    if (count === Infinity) return '🔁 **Loop** `aktif`';
    return `🔁 **Loop** diatur untuk \`${count}x\``;
  },
  looping: (t: NodeLinkTrack, remaining: number | null) => {
    const header =
      remaining === Infinity
        ? '🔁 **Memutar ulang lagu**'
        : `🔁 **Memutar ulang lagu** (sisa loop: \`${remaining}x\`)`;
    return `${header}\n${trackCard(t)}`;
  },
  volume: (vol: number) => `🔊 **Volume** \`${vol}%\`\n> ${volumeBar(vol)}`,
};

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
  private loopCount: number | null = null;
  private volume: number = 100;
  private isVoiceConnectedToNode: boolean = false;
  private lastChannelId: string | null = null;
  private activePlayingMessage: { channelId: string; messageId: string } | null = null;
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
      logger.info('Music commands open to all server members.');
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
      const num = parseInt(lower, 10);
      if (!Number.isNaN(num) && String(num) === lower) {
        if (!this.isUserAllowed(message.author.id)) {
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
            fmt.warn(`Pilih angka 1–${pendingSearch.tracks.length}.`)
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
      'jump', 'j', 'skipto',
      'pause',
      'resume',
      'queue', 'q',
      'nowplaying', 'np',
      'volume', 'vol',
      'autoplay', 'ap',
      'loop', 'l', 'repeat',
      'help',
    ];

    if (!knownCommands.includes(cmd)) return;

    // Verify user whitelist permissions (silently ignore unauthorized users)
    if (!this.isUserAllowed(message.author.id)) {
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

      case 'jump':
      case 'j':
      case 'skipto':
        await this.handleJumpCommand(message.channel_id, query);
        break;

      case 'pause':
        await this.handlePauseCommand(message.channel_id);
        break;

      case 'resume':
        await this.handleResumeCommand(message.channel_id);
        break;

      case 'queue':
      case 'q':
        await this.handleQueueCommand(message.channel_id, query);
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

      case 'loop':
      case 'l':
      case 'repeat':
        await this.handleLoopCommand(message.channel_id, query);
        break;

      case 'help':
        await this.handleHelpCommand(message.channel_id);
        break;

      default:
        break;
    }
  }

  private async enqueueOrPlayTrack(channelId: string, track: NodeLinkTrack): Promise<void> {
    if (!this.currentTrack) {
      this.currentTrack = track;
      this.loopCount = null;
      await this.startPlayback(track);
      await this.notifyNowPlaying(channelId, fmt.playing(track));
    } else {
      this.queue.push(track);
      await this.sendReply(channelId, fmt.queued(track, this.queue.length));
    }
  }

  private async handlePlayCommand(channelId: string, query: string): Promise<void> {
    if (!query) {
      await this.sendReply(
        channelId,
        fmt.warn(`Masukkan judul atau tautan. Contoh: \`${this.config.music.prefix}play suket teki didi\``)
      );
      return;
    }

    if (!this.client.isConnected()) {
      await this.sendReply(channelId, fmt.nodeNotReady);
      return;
    }

    try {
      const isUrl = /^https?:\/\//i.test(query);
      const hasPrefix = /^[a-z0-9_-]+:/i.test(query);
      const identifier = isUrl || hasPrefix ? query : `ytsearch:${query}`;

      logger.info(`Searching track via NodeLink: "${identifier}"...`);
      const result: NodeLinkLoadResult = await this.client.loadTracks(identifier);

      if (result.loadType === 'empty' || result.loadType === 'error') {
        logger.warn(`Search returned no results (loadType: ${result.loadType})`);
        await this.sendReply(channelId, fmt.notFound);
        return;
      }

      let trackToPlay: NodeLinkTrack | null = null;

      if (result.loadType === 'playlist') {
        const playlist = result.data as NodeLinkPlaylistData;
        const tracks = playlist.tracks || [];
        if (tracks.length === 0) {
          await this.sendReply(channelId, fmt.warn('Playlist kosong.'));
          return;
        }

        const isRealPlaylist =
          isUrl &&
          /(playlist|album|sets|list=)/i.test(query) &&
          !playlist.info.name.toLowerCase().includes('search results');

        if (isRealPlaylist) {
          this.queue.push(...tracks);
          await this.sendReply(channelId, fmt.playlist(playlist.info.name, tracks.length, totalDuration(tracks)));

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
        await this.sendReply(channelId, fmt.notFound);
        return;
      }

      await this.enqueueOrPlayTrack(channelId, trackToPlay);
    } catch (err) {
      logger.error(`Error handling play command: ${(err as Error).message}`);
      await this.sendReply(channelId, fmt.fail(err));
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
        fmt.warn(`Masukkan kata kunci. Contoh: \`${this.config.music.prefix}search suket teki didi\``)
      );
      return;
    }

    if (!this.client.isConnected()) {
      await this.sendReply(channelId, fmt.nodeNotReady);
      return;
    }

    try {
      const isUrl = /^https?:\/\//i.test(query);
      const hasPrefix = /^[a-z0-9_-]+:/i.test(query);
      const identifier = isUrl || hasPrefix ? query : `ytsearch:${query}`;

      logger.info(`Searching tracks interactively: "${identifier}"...`);
      const result: NodeLinkLoadResult = await this.client.loadTracks(identifier);

      if (result.loadType === 'empty' || result.loadType === 'error') {
        logger.warn(`Interactive search returned no results (loadType: ${result.loadType})`);
        await this.sendReply(channelId, fmt.notFound);
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
        await this.sendReply(channelId, fmt.notFound);
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

      const content = [
        '### 🔍 Hasil pencarian',
        candidates.map((t, i) => numberedLine(i + 1, t)).join('\n'),
        `-# Ketik 1–${candidates.length} untuk memilih`,
      ].join('\n\n');

      const sentMessageId = await this.sendReply(channelId, content);

      const timeout = setTimeout(async () => {
        const current = this.pendingSearches.get(searchKey);
        if (current) {
          this.pendingSearches.delete(searchKey);
          if (current.messageId) {
            await this.deleteMessage(channelId, current.messageId);
          }
        }
      }, 60000);

      this.pendingSearches.set(searchKey, {
        userId: authorId,
        channelId,
        messageId: sentMessageId,
        tracks: candidates,
        timeout,
      });
    } catch (err) {
      logger.error(`Error handling search command: ${(err as Error).message}`);
      await this.sendReply(channelId, fmt.fail(err));
    }
  }

  private async handleRemoveCommand(channelId: string, query: string): Promise<void> {
    if (this.queue.length === 0) {
      await this.sendReply(channelId, fmt.queueEmpty);
      return;
    }

    const idx = parseInt(query.trim(), 10);
    if (Number.isNaN(idx) || idx < 1 || idx > this.queue.length) {
      await this.sendReply(
        channelId,
        fmt.warn(`Nomor tidak valid (1–${this.queue.length}). Contoh: \`${this.config.music.prefix}remove 1\``)
      );
      return;
    }

    const removed = this.queue.splice(idx - 1, 1)[0]!;
    await this.sendReply(channelId, fmt.removed(removed));
  }

  private async handleUndoCommand(channelId: string): Promise<void> {
    if (this.queue.length === 0) {
      await this.sendReply(channelId, fmt.warn('Tidak ada lagu untuk dibatalkan.'));
      return;
    }

    const undone = this.queue.pop()!;
    await this.sendReply(channelId, fmt.undone(undone));
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
    if (this.currentTrack && this.loopCount !== null) {
      if (this.loopCount === Infinity) {
        logger.info(`Looping track (infinite): "${this.currentTrack.info.title}"`);
        if (this.lastChannelId) {
          await this.notifyNowPlaying(this.lastChannelId, fmt.looping(this.currentTrack, Infinity));
        }
        await this.startPlayback(this.currentTrack);
        return;
      }

      if (this.loopCount > 0) {
        const remaining = this.loopCount;
        this.loopCount--;
        if (this.loopCount === 0) {
          this.loopCount = null;
        }
        logger.info(`Looping track (${remaining}x remaining): "${this.currentTrack.info.title}"`);
        if (this.lastChannelId) {
          await this.notifyNowPlaying(this.lastChannelId, fmt.looping(this.currentTrack, remaining));
        }
        await this.startPlayback(this.currentTrack);
        return;
      }
    }

    if (this.queue.length > 0) {
      this.currentTrack = this.queue.shift()!;
      this.loopCount = null;
      if (this.lastChannelId) {
        await this.notifyNowPlaying(this.lastChannelId, fmt.playing(this.currentTrack));
      }
      await this.startPlayback(this.currentTrack);
      return;
    }

    if (this.isAutoplay && this.lastTrack) {
      const recommendation = await this.fetchRecommendation(this.lastTrack);
      if (recommendation) {
        this.currentTrack = recommendation;
        this.loopCount = null;
        if (this.lastChannelId) {
          await this.notifyNowPlaying(this.lastChannelId, fmt.playing(recommendation));
        }
        await this.startPlayback(recommendation);
        return;
      }
    }

    await this.cleanupActivePlayingMessage();
    this.currentTrack = null;
    this.loopCount = null;
    this.isPaused = false;
    this.voiceManager.restoreMute();
    this.client.updatePlayer(this.config.guildId, { track: { encoded: null } }).catch(() => {});
    logger.info('Queue finished. Playback stopped.');
    if (this.lastChannelId) {
      await this.sendReply(this.lastChannelId, fmt.finished);
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
      const searchQuery = `ytsearch:${previousTrack.info.author} ${previousTrack.info.title}`;
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
    await this.sendReply(channelId, fmt.autoplay(this.isAutoplay));

    // If nothing is currently playing and autoplay is turned on, trigger recommendation immediately
    if (this.isAutoplay && !this.currentTrack && this.lastTrack) {
      await this.playNext();
    }
  }

  private async handleLoopCommand(channelId: string, query?: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, fmt.nothingPlaying);
      return;
    }

    const trimmed = query?.trim().toLowerCase();

    // 1. No parameter: toggle between infinity and off
    if (!trimmed) {
      if (this.loopCount !== null) {
        this.loopCount = null;
        await this.sendReply(channelId, fmt.loop(null));
      } else {
        this.loopCount = Infinity;
        await this.sendReply(channelId, fmt.loop(Infinity));
      }
      return;
    }

    // 2. Parameter 'off' or '0'
    if (trimmed === 'off' || trimmed === '0') {
      this.loopCount = null;
      await this.sendReply(channelId, fmt.loop(null));
      return;
    }

    // 3. Parameter 'inf' or 'infinity'
    if (trimmed === 'inf' || trimmed === 'infinity') {
      this.loopCount = Infinity;
      await this.sendReply(channelId, fmt.loop(Infinity));
      return;
    }

    // 4. Numeric parameter (e.g. 2)
    const count = parseInt(trimmed, 10);
    if (Number.isNaN(count) || count < 0) {
      await this.sendReply(
        channelId,
        fmt.warn(
          `Jumlah loop tidak valid. Contoh: \`${this.config.music.prefix}loop\` (infinity) atau \`${this.config.music.prefix}loop 2\` (2x)`
        )
      );
      return;
    }

    if (count === 0) {
      this.loopCount = null;
      await this.sendReply(channelId, fmt.loop(null));
      return;
    }

    this.loopCount = count;
    await this.sendReply(channelId, fmt.loop(count));
  }

  private async handleStopCommand(channelId: string): Promise<void> {
    this.queue = [];
    this.currentTrack = null;
    this.loopCount = null;
    this.isPaused = false;
    await this.cleanupActivePlayingMessage();

    try {
      await this.client.updatePlayer(this.config.guildId, { track: { encoded: null } });
      this.voiceManager.restoreMute();
      await this.sendReply(channelId, fmt.stopped);
    } catch (err) {
      await this.sendReply(channelId, fmt.fail(err));
    }
  }

  private async handleSkipCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, fmt.nothingPlaying);
      return;
    }

    this.loopCount = null;
    await this.sendReply(channelId, fmt.skipped(this.currentTrack));
    await this.playNext();
  }

  private async handleJumpCommand(channelId: string, query: string): Promise<void> {
    if (this.queue.length === 0) {
      await this.sendReply(channelId, fmt.queueEmpty);
      return;
    }

    const idx = parseInt(query.trim(), 10);
    if (Number.isNaN(idx) || idx < 1 || idx > this.queue.length) {
      await this.sendReply(
        channelId,
        fmt.warn(`Nomor antrean tidak valid (1–${this.queue.length}). Contoh: \`${this.config.music.prefix}jump 3\``)
      );
      return;
    }

    if (idx > 1) {
      this.queue.splice(0, idx - 1);
    }
    const targetTrack = this.queue.shift()!;
    this.currentTrack = targetTrack;
    this.loopCount = null;

    await this.cleanupActivePlayingMessage();
    await this.sendReply(channelId, fmt.jumped(targetTrack, idx));
    await this.startPlayback(targetTrack);
  }

  private async handlePauseCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, fmt.nothingPlaying);
      return;
    }

    if (this.isPaused) {
      await this.sendReply(channelId, fmt.warn('Sudah dijeda.'));
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: true });
      this.isPaused = true;
      await this.sendReply(channelId, fmt.pausedNow);
    } catch (err) {
      await this.sendReply(channelId, fmt.fail(err));
    }
  }

  private async handleResumeCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, fmt.nothingPlaying);
      return;
    }

    if (!this.isPaused) {
      await this.sendReply(channelId, fmt.warn('Tidak sedang dijeda.'));
      return;
    }

    try {
      await this.client.updatePlayer(this.config.guildId, { paused: false });
      this.isPaused = false;
      await this.sendReply(channelId, fmt.resumed);
    } catch (err) {
      await this.sendReply(channelId, fmt.fail(err));
    }
  }

  private async handleQueueCommand(channelId: string, query?: string): Promise<void> {
    if (!this.currentTrack && this.queue.length === 0) {
      await this.sendAutoExpiringReply(channelId, fmt.queueEmpty, 60000);
      return;
    }

    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(this.queue.length / pageSize));

    let page = 1;
    if (query && query.trim()) {
      const parsed = parseInt(query.trim(), 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > totalPages) {
        await this.sendAutoExpiringReply(
          channelId,
          fmt.warn(`Halaman tidak valid (1–${totalPages}). Contoh: \`${this.config.music.prefix}queue 2\``),
          60000
        );
        return;
      }
      page = parsed;
    }

    const queueTotal = totalDuration(this.queue);
    const summary = [
      this.queue.length > 0 ? `${this.queue.length} lagu` : '',
      queueTotal > 0 ? `total ${formatDuration(queueTotal)}` : '',
      totalPages > 1 ? `halaman ${page}/${totalPages}` : '',
    ]
      .filter(Boolean)
      .join(' • ');

    const sections: string[] = [summary ? `### 📋 Antrean\n-# ${summary}` : '### 📋 Antrean'];

    if (this.currentTrack) {
      sections.push(`**Sedang memutar**\n${trackCard(this.currentTrack)}`);
    }

    if (this.queue.length > 0) {
      const startIdx = (page - 1) * pageSize;
      const endIdx = Math.min(startIdx + pageSize, this.queue.length);
      const listLines = this.queue
        .slice(startIdx, endIdx)
        .map((t, i) => numberedLine(startIdx + i + 1, t))
        .join('\n');

      sections.push(`**Berikutnya**\n${listLines}`);

      if (totalPages > 1) {
        sections.push(
          page < totalPages
            ? `-# Ketik \`${this.config.music.prefix}queue ${page + 1}\` untuk halaman berikutnya`
            : '-# Halaman terakhir'
        );
      }
    } else {
      sections.push(`-# Tambah dengan \`${this.config.music.prefix}play\``);
    }

    await this.sendAutoExpiringReply(channelId, sections.join('\n\n'), 60000);
  }

  private async handleNowPlayingCommand(channelId: string): Promise<void> {
    if (!this.currentTrack) {
      await this.sendReply(channelId, fmt.nothingPlaying);
      return;
    }

    let msg = this.isPaused ? fmt.paused(this.currentTrack) : fmt.playing(this.currentTrack);
    if (this.loopCount !== null) {
      const loopText = this.loopCount === Infinity ? 'infinity' : `${this.loopCount}x`;
      msg += `\n-# 🔁 Loop aktif (${loopText})`;
    }
    await this.sendReply(channelId, msg);
  }

  private async handleVolumeCommand(channelId: string, query: string): Promise<void> {
    const vol = parseInt(query, 10);
    if (Number.isNaN(vol) || vol < 0 || vol > 100) {
      await this.sendReply(
        channelId,
        fmt.warn(`Volume harus 0–100. Contoh: \`${this.config.music.prefix}volume 80\``)
      );
      return;
    }

    this.volume = vol;
    try {
      await this.client.updatePlayer(this.config.guildId, { volume: vol });
      await this.sendReply(channelId, fmt.volume(vol));
    } catch (err) {
      await this.sendReply(channelId, fmt.fail(err));
    }
  }

  private async handleHelpCommand(channelId: string): Promise<void> {
    const p = this.config.music.prefix;
    const line = (usage: string, desc: string, alias?: string) =>
      `- \`${p}${usage}\` — ${desc}${alias ? ` *(${alias})*` : ''}`;

    const help = [
      `### 📖 Perintah Musik\n-# Prefix \`${p}\` • <wajib> • [opsional]\n`,
      [
        '**🎵 Memutar**',
        line('play <judul/url>', 'Putar atau tambah ke antrean', 'p'),
        line('search <judul>', 'Cari lalu pilih 1–5', 'find'),
        line('nowplaying', 'Lagu saat ini', 'np'),
        line('autoplay', 'Rekomendasi otomatis', 'ap'),
      ].join('\n'),
      [
        '**📋 Antrean**',
        line('queue [halaman]', 'Lihat antrean', 'q'),
        line('jump <nomor>', 'Lompat ke lagu di antrean', 'j, skipto'),
        line('remove <nomor>', 'Hapus dari antrean', 'rm, del'),
        line('undo', 'Batalkan lagu terakhir yang ditambah'),
      ].join('\n'),
      [
        '**🎚️ Kontrol**',
        line('pause', 'Jeda'),
        line('resume', 'Lanjutkan'),
        line('skip', 'Lewati lagu', 's'),
        line('loop [jumlah]', 'Putar ulang lagu (default infinity)', 'l, repeat'),
        line('volume <0-100>', 'Atur volume', 'vol'),
        line('stop', 'Hentikan dan kosongkan antrean'),
      ].join('\n'),
    ].join('\n');

    await this.sendReply(channelId, help);
  }

  /** Sends reply; automatically chunked if exceeding Discord limit. Returns first message ID. */
  private async sendReply(channelId: string, content: string): Promise<string | null> {
    const chunks = splitMessage(content.trim());
    let firstId: string | null = null;

    for (const [i, chunk] of chunks.entries()) {
      const id = await this.postMessage(channelId, chunk);
      if (i === 0) firstId = id;
    }
    return firstId;
  }

  /** Sends reply that automatically gets deleted after a duration (TTL). */
  private async sendAutoExpiringReply(
    channelId: string,
    content: string,
    ttlMs: number = 60000
  ): Promise<void> {
    const chunks = splitMessage(content.trim());
    const messageIds: string[] = [];

    for (const chunk of chunks) {
      const id = await this.postMessage(channelId, chunk);
      if (id) messageIds.push(id);
    }

    if (messageIds.length > 0) {
      setTimeout(async () => {
        for (const id of messageIds) {
          await this.deleteMessage(channelId, id);
        }
      }, ttlMs);
    }
  }

  /** Cleans up the previous "now playing" message to prevent chat clutter. */
  private async cleanupActivePlayingMessage(): Promise<void> {
    if (this.activePlayingMessage) {
      const { channelId, messageId } = this.activePlayingMessage;
      this.activePlayingMessage = null;
      await this.deleteMessage(channelId, messageId);
    }
  }

  /** Sends a "now playing" message and automatically deletes the previous one. */
  private async notifyNowPlaying(channelId: string, content: string): Promise<void> {
    await this.cleanupActivePlayingMessage();
    const messageId = await this.sendReply(channelId, content);
    if (messageId) {
      this.activePlayingMessage = { channelId, messageId };
    }
  }

  private async postMessage(channelId: string, content: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const formattedContent = content.trim();

      const res = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: this.config.token,
          'Content-Type': 'application/json',
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({ content: formattedContent }),
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
    if (this.activePlayingMessage) {
      this.deleteMessage(this.activePlayingMessage.channelId, this.activePlayingMessage.messageId).catch(() => {});
      this.activePlayingMessage = null;
    }
    this.pendingSearches.clear();
    this.client.destroy();
  }
}
