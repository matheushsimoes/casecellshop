import { currentContext } from './context.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SERVICE = 'casecellshop-api';
const minLevel = (): Level => (process.env.LOG_LEVEL as Level | undefined) ?? (process.env.NODE_ENV === 'test' ? 'error' : 'info');

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < order[minLevel()]) return;
  const ctx = currentContext();
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    env: process.env.NODE_ENV ?? 'local',
    event,
    correlationId: ctx?.correlationId,
    traceId: ctx?.traceId,
    spanId: ctx?.spanId,
    orderId: ctx?.orderId,
    ...fields,
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
