import type { NodeLinkTrack } from '../../types/nodelink.js';

export function formatDuration(ms: number): string {
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
export function escapeMarkdown(text: string): string {
  return text.replace(/([\[\]\\*_`~|>])/g, '\\$1');
}

export function formatTrackLink(title: string, uri?: string): string {
  const label = escapeMarkdown(title);
  if (uri && uri.startsWith('http')) {
    return `[${label}](<${uri}>)`;
  }
  return label;
}

/** Total duration (live streams or invalid durations are skipped) */
export function totalDuration(tracks: NodeLinkTrack[]): number {
  return tracks.reduce((sum, t) => {
    const len = t.info.length;
    return Number.isFinite(len) && len > 0 ? sum + len : sum;
  }, 0);
}

/** Formats " by Artist" suffix (empty if artist is unavailable) */
export function byAuthor(author?: string): string {
  return author ? ` by ${escapeMarkdown(author)}` : '';
}

/** Concise single line: Title by Artist `03:45` — duration in code span separated from link */
export function trackLine(track: NodeLinkTrack): string {
  const { title, uri, author, length } = track.info;
  return `${formatTrackLink(title, uri)}${byAuthor(author)} \`${formatDuration(length)}\``;
}

/** Track card (single-line blockquote): **Title** by Artist `03:45` */
export function trackCard(track: NodeLinkTrack): string {
  const { title, uri, author, length } = track.info;
  return `> **${formatTrackLink(title, uri)}**${byAuthor(author)} \`${formatDuration(length)}\``;
}

/** Numbered list line: 1. Title `03:45` */
export function numberedLine(index: number, track: NodeLinkTrack): string {
  return `${index}. ${trackLine(track)}`;
}

export function volumeBar(volume: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(volume / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/**
 * Reply message templates.
 * - Track status : icon **Label** + track card (blockquote)
 * - Lists        : header `###` + list + footer subtext `-#`
 */
export const fmt = {
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
