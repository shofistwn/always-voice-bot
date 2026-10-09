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
export function resolveIdentifier(input: string): string {
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

/** Fetches track title via Spotify public oEmbed endpoint for fallback search */
export async function resolveSpotifyFallback(url: string): Promise<string | null> {
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
