export const GATEWAY_OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  VOICE_STATE_UPDATE: 4,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  STREAM_WATCH: 20,
} as const;

export const DISCORD_GATEWAY = {
  DEFAULT_URL: 'wss://gateway.discord.gg/?v=10&encoding=json',
  API_BASE_URL: 'https://discord.com/api/v10',
  DEFAULT_USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Intents: GUILDS (1) | GUILD_VOICE_STATES (128) | GUILD_MESSAGES (512) | MESSAGE_CONTENT (32768) = 33409
  INTENTS: 33409,
} as const;
