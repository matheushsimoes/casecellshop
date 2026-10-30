import { currentContext, newSpanId, runWithContext } from './context.ts';
import { logger } from './logger.ts';

export async function withSpan<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
  const parent = currentContext();
  if (!parent) return fn();
  const child = { ...parent, spanId: newSpanId() };
  const start = performance.now();
  return runWithContext(child, async () => {
    try {
      const result = await fn();
      logger.debug('span.end', { span: name, parentSpanId: parent.spanId, durationMs: round(performance.now() - start), status: 'ok', ...attributes });
      return result;
    } catch (err) {
      logger.debug('span.end', { span: name, parentSpanId: parent.spanId, durationMs: round(performance.now() - start), status: 'error', error: (err as Error).message, ...attributes });
      throw err;
    }
  });
}

const round = (n: number): number => Math.round(n * 100) / 100;
