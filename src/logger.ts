type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const l = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(l as Level) ? (l as Level) : 'info';
}

function emit(level: Level, args: unknown[]): void {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(prefix, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};
