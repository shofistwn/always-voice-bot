import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Session');

interface SessionData {
  sessionId: string | null;
  lastSequence: number | null;
  resumeGatewayUrl: string | null;
}

export class GatewaySession {
  private sessionId: string | null = null;
  private lastSequence: number | null = null;
  private resumeGatewayUrl: string | null = null;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve(process.cwd(), '.session.json');
    this.loadFromDisk();
  }

  public setSession(sessionId: string, resumeUrl: string): void {
    this.sessionId = sessionId;
    this.resumeGatewayUrl = resumeUrl;
    this.saveToDisk();
  }

  public setSequence(seq: number | null): void {
    if (seq !== null) {
      this.lastSequence = seq;
      this.saveToDisk();
    }
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getSequence(): number | null {
    return this.lastSequence;
  }

  public getResumeGatewayUrl(): string | null {
    return this.resumeGatewayUrl;
  }

  public canResume(): boolean {
    return Boolean(this.sessionId && this.lastSequence !== null && this.resumeGatewayUrl);
  }

  public reset(): void {
    this.sessionId = null;
    this.lastSequence = null;
    this.resumeGatewayUrl = null;

    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
        logger.info('Session cache cleared.');
      }
    } catch {
      // Ignore cleanup error
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw) as SessionData;
        if (data.sessionId && data.resumeGatewayUrl) {
          this.sessionId = data.sessionId;
          this.lastSequence = data.lastSequence;
          this.resumeGatewayUrl = data.resumeGatewayUrl;
          logger.info(`Restored session from cache (seq: ${this.lastSequence ?? 0})`);
        }
      }
    } catch {
      // Ignore corrupted or unreadable cache file
    }
  }

  private saveToDisk(): void {
    try {
      const data: SessionData = {
        sessionId: this.sessionId,
        lastSequence: this.lastSequence,
        resumeGatewayUrl: this.resumeGatewayUrl,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf-8');
    } catch {
      // Ignore filesystem write error in restricted environments
    }
  }
}
