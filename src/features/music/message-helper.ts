import { DISCORD_GATEWAY } from '../../constants/discord.js';
import { createLogger } from '../../logger/index.js';
import type { ActiveMessage } from './types.js';

const logger = createLogger('MusicMessenger');

/** Discord single message length limit */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Splits long message into chunks ≤ limit.
 * Cut priority: section breaks (empty lines) → newlines → hard character cut.
 */
export function splitMessage(content: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
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

export class DiscordMessenger {
  private readonly token: string;
  private activePlayingMessage: ActiveMessage | null = null;
  private readonly pendingTimeouts: Set<NodeJS.Timeout> = new Set();

  constructor(token: string) {
    this.token = token;
  }

  public async postMessage(channelId: string, content: string): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const formattedContent = content.trim();

      const res = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/json',
          'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
        },
        body: JSON.stringify({ content: formattedContent }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        logger.error(`Failed to send message: ${res.status} ${res.statusText} (${errorText})`);
        return null;
      }

      const data = (await res.json()) as { id?: string };
      return data.id ?? null;
    } catch (err) {
      logger.error(`Error sending message: ${(err as Error).message}`);
      return null;
    }
  }

  public async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      const res = await fetch(
        `${DISCORD_GATEWAY.API_BASE_URL}/channels/${channelId}/messages/${messageId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: this.token,
            'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
          },
        }
      );

      if (!res.ok && res.status !== 404) {
        const errText = await res.text().catch(() => '');
        logger.warn(`Failed to delete message: ${res.status} ${res.statusText} (${errText})`);
      }
    } catch (err) {
      logger.warn(`Failed to delete message: ${(err as Error).message}`);
    }
  }

  /** Sends reply; automatically chunked if exceeding Discord limit. Returns first message ID. */
  public async sendReply(channelId: string, content: string): Promise<string | null> {
    const chunks = splitMessage(content.trim());
    let firstId: string | null = null;

    for (const [i, chunk] of chunks.entries()) {
      const id = await this.postMessage(channelId, chunk);
      if (i === 0) firstId = id;
    }
    return firstId;
  }

  /** Sends reply that automatically gets deleted after a duration (TTL). */
  public async sendAutoExpiringReply(
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
      const timer = setTimeout(async () => {
        this.pendingTimeouts.delete(timer);
        for (const id of messageIds) {
          await this.deleteMessage(channelId, id);
        }
      }, ttlMs);
      this.pendingTimeouts.add(timer);
    }
  }

  /** Cleans up the previous "now playing" message to prevent chat clutter. */
  public async cleanupActivePlayingMessage(): Promise<void> {
    if (this.activePlayingMessage) {
      const { channelId, messageId } = this.activePlayingMessage;
      this.activePlayingMessage = null;
      await this.deleteMessage(channelId, messageId);
    }
  }

  /** Sends a "now playing" message and automatically deletes the previous one. */
  public async notifyNowPlaying(channelId: string, content: string): Promise<void> {
    await this.cleanupActivePlayingMessage();
    const messageId = await this.sendReply(channelId, content);
    if (messageId) {
      this.activePlayingMessage = { channelId, messageId };
    }
  }

  public destroy(): void {
    for (const timer of this.pendingTimeouts) {
      clearTimeout(timer);
    }
    this.pendingTimeouts.clear();

    if (this.activePlayingMessage) {
      this.deleteMessage(this.activePlayingMessage.channelId, this.activePlayingMessage.messageId).catch(() => {});
      this.activePlayingMessage = null;
    }
  }
}
