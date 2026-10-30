import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type AppConfig } from '../src/app.ts';

process.env.NODE_ENV = 'test';

/** Config rápida e determinística para testes: sem latência, sem erro aleatório, retries curtos. */
export const testConfig: Partial<AppConfig> = {
  erpLatencyMs: 0,
  erpTimeoutMs: 50,
  erpHangMs: 200,
  erpInvoiceErrorRate: 0,
  cacheJitterRatio: 0,
  queueBaseDelayMs: 1,
  queueMaxDelayMs: 5,
  queueMaxAttempts: 4,
};

export async function startApp(overrides: Partial<AppConfig> = {}) {
  const app = createApp({ ...testConfig, ...overrides });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const checkout = (items: Array<{ sku: string; quantity: number }>, key: string = randomUUID()) =>
    fetch(`${base}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ items }),
    });

  return { app, base, checkout };
}
