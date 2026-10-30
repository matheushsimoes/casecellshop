import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

export type RequestContext = {
  correlationId: string;
  traceId: string;
  spanId: string;
  orderId?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');
export const newCorrelationId = (): string => randomUUID();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function enrichContext(fields: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, fields);
}

export function toTraceparent(ctx: RequestContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

export function fromTraceparent(header: string | undefined): { traceId: string; parentSpanId: string } | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(header ?? '');
  return match ? { traceId: match[1]!, parentSpanId: match[2]! } : undefined;
}
