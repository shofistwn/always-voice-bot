export const GATEWAY_OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  STREAM_CREATE: 18,
  STREAM_DELETE: 19,
  STREAM_WATCH: 20,
  STREAM_PING: 21,
  STREAM_SET_PAUSED: 22,
} as const;

export const DISCORD_GATEWAY = {
  DEFAULT_URL: 'wss://gateway.discord.gg/?v=10&encoding=json',
  API_BASE_URL: 'https://discord.com/api/v10',
  DEFAULT_USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Intents: GUILDS (1) | GUILD_VOICE_STATES (128) | GUILD_MESSAGES (512) = 641
  INTENTS: 641,
} as const;
