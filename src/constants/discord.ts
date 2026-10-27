export const GATEWAY_OPCODES = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Intents: GUILDS (1) | GUILD_VOICE_STATES (128) | GUILD_MESSAGES (512) | MESSAGE_CONTENT (32768) = 33409
  INTENTS: 33409,
} as const;

export const DISCORD_CLIENT_PROPERTIES = {
  os: 'Windows',
  browser: 'Chrome',
  device: '',
  system_locale: 'en-US',
  browser_user_agent: DISCORD_GATEWAY.DEFAULT_USER_AGENT,
  browser_version: '131.0.0.0',
  os_version: '10',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 353526,
  client_event_source: null,
} as const;

export const SUPER_PROPERTIES_B64 = Buffer.from(
  JSON.stringify(DISCORD_CLIENT_PROPERTIES)
).toString('base64');

export function generateNonce(): string {
  // Discord epoch is 2015-01-01T00:00:00.000Z = 1420070400000ms
  const discordEpoch = 1420070400000n;
  const now = BigInt(Date.now());
  const snowflake = ((now - discordEpoch) << 22n) + BigInt(Math.floor(Math.random() * 4194304));
  return snowflake.toString();
}
