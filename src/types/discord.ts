export interface GatewayPayload<T = unknown> {
  op: number;
  d: T;
  s: number | null;
  t: string | null;
}

export interface HelloData {
  heartbeat_interval: number;
}

export interface User {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string | null;
}

export interface ReadyEventData {
  v: number;
  user: User;
  session_id: string;
  resume_gateway_url: string;
}

export interface VoiceState {
  guild_id?: string;
  channel_id: string | null;
  user_id: string;
  session_id?: string;
  deaf?: boolean;
  mute?: boolean;
  self_deaf?: boolean;
  self_mute?: boolean;
}

export interface GuildCreateData {
  id: string;
  voice_states?: VoiceState[];
}

export interface MessageAuthor {
  id: string;
  username: string;
}

export interface MentionUser {
  id: string;
  username?: string;
}

export interface MessageCreateData {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: MessageAuthor;
  content: string;
  mentions: MentionUser[];
}
