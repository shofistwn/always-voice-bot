import { config } from './config/index.js';
import { AlwaysVoiceBot } from './bot.js';
import { createLogger } from './logger/index.js';

const logger = createLogger('App');
const bot = new AlwaysVoiceBot(config);

function handleShutdown(signal: string): void {
  logger.info(`Received ${signal}. Shutting down process...`);
  bot.stop();
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}. Exiting for Docker restart...`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${String(reason)}. Exiting for Docker restart...`);
  process.exit(1);
});

bot.start();
