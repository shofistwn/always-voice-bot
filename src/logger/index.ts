export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  SUCCESS: 1,
  WARN: 2,
  ERROR: 3,
};

const COLOR_CODES = {
  RESET: '\x1b[0m',
  DIM: '\x1b[90m',
  DEBUG: '\x1b[35m',   // Magenta
  INFO: '\x1b[36m',    // Cyan
  SUCCESS: '\x1b[32m', // Green
  WARN: '\x1b[33m',    // Yellow
  ERROR: '\x1b[31m',   // Red
  SCOPE: '\x1b[37m',   // Normal White (non-bold)
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO ',
  SUCCESS: 'OK   ',
  WARN: 'WARN ',
  ERROR: 'ERROR',
};

function getActiveLogLevel(): number {
  const envLevel = (process.env.LOG_LEVEL || 'info').trim().toUpperCase() as LogLevel;
  return LOG_LEVEL_PRIORITY[envLevel] ?? LOG_LEVEL_PRIORITY.INFO;
}

function formatTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export interface ScopedLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
}

export function log(level: LogLevel, scopeOrMessage: string, message?: string): void {
  const activeLevel = getActiveLogLevel();
  if (LOG_LEVEL_PRIORITY[level] < activeLevel) {
    return;
  }

  const timestamp = formatTimestamp();
  const levelColor = COLOR_CODES[level] ?? '';
  const levelText = LEVEL_LABELS[level] ?? level;

  // Status level without brackets, padded to align (5 characters)
  const levelFormatted = `${levelColor}${levelText}${COLOR_CODES.RESET}`;

  // Scope with brackets, padded to align (9 characters), regular font
  const scopeBadge =
    message !== undefined
      ? ` [${COLOR_CODES.SCOPE}${scopeOrMessage.padEnd(9, ' ')}${COLOR_CODES.RESET}]`
      : '';
  const logText = message !== undefined ? message : scopeOrMessage;

  const output = `${COLOR_CODES.DIM}[${timestamp}]${COLOR_CODES.RESET} ${levelFormatted}${scopeBadge} ${logText}`;

  if (level === 'ERROR') {
    console.error(output);
  } else if (level === 'WARN') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export function createLogger(scope: string): ScopedLogger {
  return {
    debug: (msg: string) => log('DEBUG', scope, msg),
    info: (msg: string) => log('INFO', scope, msg),
    warn: (msg: string) => log('WARN', scope, msg),
    error: (msg: string) => log('ERROR', scope, msg),
    success: (msg: string) => log('SUCCESS', scope, msg),
  };
}
