import type { GuildCreateData, MessageCreateData, ReadyEventData, VoiceState } from '../types/discord.js';

export class EntityCache {
  private readonly channels: Map<string, string> = new Map();
  private readonly users: Map<string, string> = new Map();

  public getChannelName(id: string): string {
    const name = this.channels.get(id);
    return name ? `#${name}` : id;
  }

  public getUserName(id: string): string {
    return this.users.get(id) ?? `user ${id}`;
  }

  public handleReady(data: ReadyEventData): void {
    if (Array.isArray(data.guilds)) {
      for (const guild of data.guilds) {
        this.handleGuildCreate(guild);
      }
    }

    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        if (u.id && u.username) {
          this.users.set(u.id, u.username);
        }
      }
    }
  }

  public handleGuildCreate(data: GuildCreateData): void {
    if (Array.isArray(data.channels)) {
      for (const ch of data.channels) {
        if (ch.id && ch.name) {
          this.channels.set(ch.id, ch.name);
        }
      }
    }

    if (Array.isArray(data.members)) {
      for (const m of data.members) {
        if (m.user?.id && m.user.username) {
          this.users.set(m.user.id, m.user.username);
        }
      }
    }
  }

  public handleVoiceStateUpdate(data: VoiceState): void {
    if (data.member?.user?.id && data.member.user.username) {
      this.users.set(data.member.user.id, data.member.user.username);
    }
  }

  public handleMessageCreate(data: MessageCreateData): void {
    if (data.author?.id && data.author.username) {
      this.users.set(data.author.id, data.author.username);
    }
  }

  public clear(): void {
    this.channels.clear();
    this.users.clear();
  }
}
