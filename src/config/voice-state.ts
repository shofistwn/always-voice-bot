import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger/index.js';

const logger = createLogger('VoiceState');

export interface VoiceStateData {
  guildId: string;
  channelId: string;
}

const DEFAULT_STATE_FILE = path.resolve(process.cwd(), 'voice-state.json');

export class VoiceStateStore {
  private readonly filePath: string;
  private state: VoiceStateData;

  constructor(filePath: string = DEFAULT_STATE_FILE) {
    this.filePath = filePath;
    this.state = this.loadFromFile();
  }

  public get channelId(): string {
    return this.state.channelId;
  }

  public get guildId(): string {
    return this.state.guildId;
  }

  public hasVoiceChannel(): boolean {
    return Boolean(this.state.channelId);
  }

  public hasFile(): boolean {
    return fs.existsSync(this.filePath);
  }

  public getState(): VoiceStateData {
    return { ...this.state };
  }

  public setChannelId(newChannelId: string, guildId?: string): void {
    this.state.channelId = newChannelId;
    if (guildId) {
      this.state.guildId = guildId;
    }
    this.save();
  }

  public setGuildId(newGuildId: string): void {
    if (this.state.guildId === newGuildId) return;
    this.state.guildId = newGuildId;
    this.save();
  }

  public clear(): void {
    this.state = {
      guildId: '',
      channelId: '',
    };
    try {
      if (fs.existsSync(this.filePath)) {
        try {
          fs.unlinkSync(this.filePath);
          logger.info(`Removed voice state file at ${path.basename(this.filePath)}`);
        } catch (unlinkErr) {
          // In Docker file-mounts, unlink fails with EBUSY. Empty the file instead.
          fs.writeFileSync(this.filePath, JSON.stringify({ guildId: '', channelId: '' }, null, 2), 'utf-8');
          logger.info(`Cleared voice state content in ${path.basename(this.filePath)}`);
        }
      }
    } catch (err) {
      logger.error(
        `Failed to clear voice state at ${this.filePath}: ${(err as Error).message}`
      );
    }
  }

  private loadFromFile(): VoiceStateData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
        if (!raw) {
          logger.info('voice-state.json is empty. Bot will not join voice until configured.');
          return { guildId: '', channelId: '' };
        }

        const parsed = JSON.parse(raw) as Partial<VoiceStateData>;
        const guildId = parsed.guildId?.trim() || '';
        const channelId = parsed.channelId?.trim() || '';

        if (!channelId) {
          logger.info('voice-state.json has no channelId. Bot will not join voice until configured.');
          return { guildId, channelId: '' };
        }

        return { guildId, channelId };
      }
    } catch (err) {
      logger.warn(
        `Failed to parse voice state file at ${this.filePath}: ${(err as Error).message}`
      );
    }

    logger.info('voice-state.json not found or unreadable. Bot will not join voice until configured.');
    return {
      guildId: '',
      channelId: '',
    };
  }

  public save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
      logger.info(
        `Saved voice state: guild=${this.state.guildId || 'none'}, channel=${this.state.channelId || 'none'}`
      );
    } catch (err) {
      logger.error(
        `Failed to write voice state to ${this.filePath}: ${(err as Error).message}`
      );
    }
  }
}

export const voiceStateStore = new VoiceStateStore();
