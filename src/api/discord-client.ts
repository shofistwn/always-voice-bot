import {
  DISCORD_GATEWAY,
  SUPER_PROPERTIES_B64,
  generateNonce,
} from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('DiscordAPI');

interface QueueTask<T> {
  routeKey: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface BucketState {
  remaining: number;
  resetAt: number; // Date.now()-based timestamp
}

export class DiscordApiClient {
  private readonly token: string;
  private readonly timezone: string;
  private isProcessingQueue: boolean = false;
  private queue: QueueTask<unknown>[] = [];
  private lastRequestTime: number = 0;

  // Per-route rate limit buckets keyed by route pattern
  private readonly buckets: Map<string, BucketState> = new Map();
  // Global rate limit: blocks ALL routes
  private globalRateLimitUntil: number = 0;

  constructor(token: string) {
    this.token = token;
    try {
      this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Jakarta';
    } catch {
      this.timezone = 'Asia/Jakarta';
    }
  }

  private getStandardHeaders(): Record<string, string> {
    return {
      Authorization: this.token,
      'Content-Type': 'application/json',
      'User-Agent': DISCORD_GATEWAY.DEFAULT_USER_AGENT,
      'X-Super-Properties': SUPER_PROPERTIES_B64,
      'X-Discord-Locale': 'en-US',
      'X-Discord-Timezone': this.timezone,
      Origin: 'https://discord.com',
      Referer: 'https://discord.com/channels/@me',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
  }

  /**
   * Derive a route key for rate-limit bucketing.
   * Discord buckets per (method, route_pattern) where major params (channel_id, guild_id) are kept.
   */
  private static routeKey(method: string, path: string): string {
    // Keep the channel/guild ID in the key since Discord buckets per major param
    return `${method}:${path}`;
  }

  private enqueue<T>(routeKey: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        routeKey,
        run: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.queue.length > 0) {
      const now = Date.now();

      // Respect global rate limit
      if (this.globalRateLimitUntil > now) {
        const waitMs = this.globalRateLimitUntil - now;
        logger.warn(`Global rate limit active. Waiting ${(waitMs / 1000).toFixed(1)}s`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      // Find next item whose route bucket is not exhausted
      let nextIdx = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i]!;
        const bucket = this.buckets.get(item.routeKey);
        if (!bucket || bucket.remaining > 0 || bucket.resetAt <= Date.now()) {
          nextIdx = i;
          break;
        }
      }

      if (nextIdx === -1) {
        // All queued items are bucket-blocked; wait for the earliest reset
        let earliestReset = Infinity;
        for (const item of this.queue) {
          const bucket = this.buckets.get(item.routeKey);
          if (bucket && bucket.resetAt < earliestReset) {
            earliestReset = bucket.resetAt;
          }
        }
        const waitMs = Math.max(100, earliestReset - Date.now());
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      // Human-like pacing between successive requests (1.2s - 2.8s)
      const elapsedSinceLast = Date.now() - this.lastRequestTime;
      const minInterval = Math.floor(Math.random() * 1600) + 1200;
      if (elapsedSinceLast < minInterval) {
        await new Promise((resolve) => setTimeout(resolve, minInterval - elapsedSinceLast));
      }

      const item = this.queue.splice(nextIdx, 1)[0]!;

      try {
        const result = await item.run();
        this.lastRequestTime = Date.now();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Read Discord rate-limit response headers and update bucket state.
   */
  private updateRateLimits(routeKey: string, response: Response): void {
    // Check for global rate limit
    const isGlobal = response.headers.get('x-ratelimit-global');
    if (isGlobal === 'true') {
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter ? Math.ceil(parseFloat(retryAfter) * 1000) + 500 : 60000;
      this.globalRateLimitUntil = Date.now() + waitMs;
      logger.warn(`Global rate limit hit! Blocking all requests for ${(waitMs / 1000).toFixed(1)}s`);
      return;
    }

    // Per-route bucket update
    const remaining = response.headers.get('x-ratelimit-remaining');
    const resetAfter = response.headers.get('x-ratelimit-reset-after');

    if (remaining !== null && resetAfter !== null) {
      this.buckets.set(routeKey, {
        remaining: parseInt(remaining, 10),
        resetAt: Date.now() + Math.ceil(parseFloat(resetAfter) * 1000) + 200,
      });
    }
  }

  /**
   * Handle a 429 response: extract retry_after, update state, optionally retry.
   * Returns the retry_after duration in ms.
   */
  private async handle429(routeKey: string, response: Response): Promise<number> {
    let retryAfter = 5;

    const isGlobal = response.headers.get('x-ratelimit-global') === 'true';

    try {
      const data = (await response.json()) as { retry_after?: number; global?: boolean };
      if (typeof data.retry_after === 'number') {
        retryAfter = data.retry_after;
      }
    } catch {
      const headerRetry = response.headers.get('retry-after');
      if (headerRetry) retryAfter = parseFloat(headerRetry);
    }

    const waitMs = Math.ceil(retryAfter * 1000) + 1500;

    if (isGlobal) {
      this.globalRateLimitUntil = Date.now() + waitMs;
      logger.warn(`[429 Global] All routes blocked for ${(waitMs / 1000).toFixed(1)}s`);
    } else {
      this.buckets.set(routeKey, { remaining: 0, resetAt: Date.now() + waitMs });
      logger.warn(`[429 Route] ${routeKey} blocked for ${(waitMs / 1000).toFixed(1)}s`);
    }

    return waitMs;
  }

  public async sendMessage(channelId: string, content: string, retryCount = 0): Promise<boolean> {
    const route = `/channels/${channelId}/messages`;
    const routeKey = DiscordApiClient.routeKey('POST', route);

    return this.enqueue(routeKey, async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(
          `${DISCORD_GATEWAY.API_BASE_URL}${route}`,
          {
            method: 'POST',
            headers: this.getStandardHeaders(),
            body: JSON.stringify({
              content,
              nonce: generateNonce(),
              tts: false,
              flags: 0,
            }),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);
        this.updateRateLimits(routeKey, response);

        if (response.status === 429) {
          const waitMs = await this.handle429(routeKey, response);
          if (retryCount < 3) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            return this.sendMessage(channelId, content, retryCount + 1);
          }
          return false;
        }

        if (!response.ok) {
          logger.warn(`Message send returned HTTP ${response.status}`);
          return false;
        }

        return true;
      } catch (error) {
        logger.error(`Message dispatch failed: ${(error as Error).message}`);
        return false;
      }
    });
  }

  public async sendTyping(channelId: string): Promise<void> {
    const route = `/channels/${channelId}/typing`;
    const routeKey = DiscordApiClient.routeKey('POST', route);

    return this.enqueue(routeKey, async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${DISCORD_GATEWAY.API_BASE_URL}${route}`, {
          method: 'POST',
          headers: this.getStandardHeaders(),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        this.updateRateLimits(routeKey, response);

        if (response.status === 429) {
          await this.handle429(routeKey, response);
          // Don't retry typing; it's non-critical
        }
      } catch {
        // Typing indicator failure is non-fatal
      }
    });
  }
}
