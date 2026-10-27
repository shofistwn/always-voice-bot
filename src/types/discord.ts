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

export interface GuildMember {
  user?: User;
  nick?: string | null;
}

export interface ReadyEventData {
  v: number;
  user: User;
  session_id: string;
  resume_gateway_url: string;
  guilds?: GuildCreateData[];
  users?: User[];
}

export interface ReadySupplementalGuild {
  id: string;
  voice_states?: VoiceState[];
}

export interface ReadySupplementalData {
  guilds?: ReadySupplementalGuild[];
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
  self_stream?: boolean;
  self_video?: boolean;
  member?: GuildMember;
}

export interface GuildChannel {
  id: string;
  name: string;
  type?: number;
}

export interface GuildCreateData {
  id: string;
  name?: string;
  channels?: GuildChannel[];
  members?: GuildMember[];
  voice_states?: VoiceState[];
}

export interface MessageAuthor {
  id: string;
  username: string;
}

export interface MessageMention {
  id: string;
  username: string;
}

export interface MessageCreateData {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: MessageAuthor;
  content: string;
  mentions: MessageMention[];
}

export interface StreamCreateData {
  stream_key: string;
  viewer_ids?: string[];
  rtc_server_id?: string;
  paused?: boolean;
}

export interface StreamDeleteData {
  stream_key: string;
}
