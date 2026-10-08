import { GATEWAY_OPCODES } from '../constants/discord.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger('Heartbeat');

export interface HeartbeatSender {
  send(data: string): void;
  getSequence(): number | null;
}

export class HeartbeatManager {
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private intervalMs: number = 0;
  private sender: HeartbeatSender;
  private acknowledged: boolean = true;
  private onZombieConnection?: () => void;

  constructor(sender: HeartbeatSender, onZombieConnection?: () => void) {
    this.sender = sender;
    this.onZombieConnection = onZombieConnection;
  }

  public start(intervalMs: number): void {
    this.stop();
    this.intervalMs = intervalMs;
    this.acknowledged = true;

    // Discord Gateway v10: Apply jitter to the first heartbeat (interval * Math.random())
    const initialJitter = Math.floor(intervalMs * Math.random());
    const intervalSec = (intervalMs / 1000).toFixed(1);
    const jitterSec = (initialJitter / 1000).toFixed(1);
    logger.info(`Loop started (interval: ${intervalSec}s, initial jitter: ${jitterSec}s)`);

    this.initialTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.initialTimer = null;

      // Regular heartbeat interval thereafter
      this.intervalTimer = setInterval(() => {
        if (!this.acknowledged) {
          logger.warn('Heartbeat ACK was not received before next heartbeat. Zombie connection detected.');
          this.stop();
          this.onZombieConnection?.();
          return;
        }

        this.acknowledged = false;
        this.sendHeartbeat();
      }, this.intervalMs);
    }, initialJitter);
  }

  public sendHeartbeat(): void {
    try {
      const seq = this.sender.getSequence();
      const payload = JSON.stringify({
        op: GATEWAY_OPCODES.HEARTBEAT,
        d: seq,
      });
      this.sender.send(payload);
      logger.debug(`Heartbeat sent (sequence: ${seq ?? 'null'})`);
    } catch (error) {
      logger.warn(`Failed to dispatch heartbeat: ${(error as Error).message}`);
    }
  }

  public acknowledge(): void {
    this.acknowledged = true;
    logger.debug('Heartbeat acknowledged (ACK received)');
  }

  public stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}
