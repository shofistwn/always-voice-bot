export type OnlineStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface BotConfig {
  token: string;
  guildId: string;
  channelId: string;
  voiceLimit: number;
  status: OnlineStatus;
  selfMute: boolean;
  selfDeaf: boolean;
  autoWatchStream: boolean;

  autoReply: {
    enabled: boolean;
    trigger: string;
    message: string;
    delaySeconds: number;
  };
}
