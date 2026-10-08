import { config } from './config/index.js';
import { AlwaysVoiceBot } from './bot.js';
import { createLogger } from './logger/index.js';

const logger = createLogger('App');
const bot = new AlwaysVoiceBot(config);

function handleShutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down...`);
  bot.stop();
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${String(reason)}`);
  process.exit(1);
});

bot.start();
