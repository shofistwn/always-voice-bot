export interface NodeLinkTrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  length: number;
  isStream: boolean;
  position: number;
  title: string;
  uri?: string;
  artworkUrl?: string;
  isrc?: string | null;
  sourceName: string;
}

export interface NodeLinkTrack {
  encoded: string;
  info: NodeLinkTrackInfo;
}

export interface NodeLinkPlaylistInfo {
  name: string;
  selectedTrack?: number;
}

export interface NodeLinkPlaylistData {
  info: NodeLinkPlaylistInfo;
  pluginInfo?: Record<string, unknown>;
  tracks: NodeLinkTrack[];
}

export interface NodeLinkLoadResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  data: NodeLinkTrack | NodeLinkPlaylistData | NodeLinkTrack[] | Record<string, unknown>;
}

export interface NodeLinkVoiceUpdate {
  token: string;
  endpoint: string;
  sessionId: string;
}

export interface NodeLinkPlayerUpdate {
  track?: {
    encoded: string | null;
  };
  position?: number;
  endTime?: number | null;
  volume?: number;
  paused?: boolean;
  voice?: NodeLinkVoiceUpdate;
}
