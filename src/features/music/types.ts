import type { NodeLinkTrack } from '../../types/nodelink.js';

export interface PendingSearch {
  userId: string;
  channelId: string;
  messageId?: string | null;
  tracks: NodeLinkTrack[];
  timeout: NodeJS.Timeout;
}

export interface ActiveMessage {
  channelId: string;
  messageId: string;
}
