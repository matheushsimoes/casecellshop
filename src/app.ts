import type { Server } from 'node:http';
import { CatalogService } from './catalog/catalogService.ts';
import { SwrCache } from './catalog/swrCache.ts';
import { FakeErp, type ErpProduct } from './erp/fakeErp.ts';
import { createHttpServer } from './http/server.ts';
import { Inventory } from './inventory/inventory.ts';
import { OutboxDispatcher } from './messaging/outboxDispatcher.ts';
import { InMemoryQueue } from './messaging/queue.ts';
import { createMetrics } from './observability/metrics.ts';
import { CheckoutService } from './orders/checkoutService.ts';
import { CheckoutWorker } from './orders/checkoutWorker.ts';
import { OrderStore } from './orders/orderStore.ts';
import { Reconciler } from './orders/reconciler.ts';

export type AppConfig = {
  products: ErpProduct[];
  stock: Record<string, number>;
  erpLatencyMs: number;
  erpTimeoutMs: number;
  erpHangMs: number;
  erpInvoiceErrorRate: number;
  cacheTtlMs: number;
  cacheStaleMs: number;
  cacheJitterRatio: number;
  queueMaxAttempts: number;
  queueBaseDelayMs: number;
  queueMaxDelayMs: number;
  workerConcurrency: number;
  reconcileStaleAfterMs: number;
  now?: () => number;
};

export const defaultProducts: ErpProduct[] = [
  { sku: 'CASE-IP15-BLK', name: 'Capinha iPhone 15 Preta', priceCents: 4990 },
  { sku: 'CASE-IP15-CLR', name: 'Capinha iPhone 15 Transparente', priceCents: 3990 },
  { sku: 'CASE-S24-BLU', name: 'Capinha Galaxy S24 Azul', priceCents: 4490 },
];

export const defaultConfig: AppConfig = {
  products: defaultProducts,
  stock: { 'CASE-IP15-BLK': 10, 'CASE-IP15-CLR': 5, 'CASE-S24-BLU': 3 },
  erpLatencyMs: 300,
  erpTimeoutMs: 2_000,
  erpHangMs: 10_000,
  erpInvoiceErrorRate: 0.3,
  cacheTtlMs: 30_000,
  cacheStaleMs: 120_000,
  cacheJitterRatio: 0.1,
  queueMaxAttempts: 5,
  queueBaseDelayMs: 500,
  queueMaxDelayMs: 8_000,
  workerConcurrency: 4,
  reconcileStaleAfterMs: 5 * 60_000,
};

/** Monta todas as peças. Usado pelo main.ts e pelos testes (com config própria). */
export function createApp(overrides: Partial<AppConfig> = {}) {
  const config: AppConfig = { ...defaultConfig, ...overrides };
  const metrics = createMetrics();
  const erp = new FakeErp({ products: config.products, latencyMs: config.erpLatencyMs, hangMs: config.erpHangMs, invoiceErrorRate: config.erpInvoiceErrorRate });
  const inventory = new Inventory(config.stock, metrics);
  const store = new OrderStore();
  const queue = new InMemoryQueue({
    maxAttempts: config.queueMaxAttempts,
    baseDelayMs: config.queueBaseDelayMs,
    maxDelayMs: config.queueMaxDelayMs,
    concurrency: config.workerConcurrency,
    metrics,
  });
  const dispatcher = new OutboxDispatcher(store, queue);
  const cache = new SwrCache<ErpProduct[]>({
    name: 'catalog',
    ttlMs: config.cacheTtlMs,
    staleMs: config.cacheStaleMs,
    jitterRatio: config.cacheJitterRatio,
    now: config.now,
    metrics,
  });
  const catalog = new CatalogService(erp, inventory, metrics, cache);
  const checkout = new CheckoutService(store, inventory, metrics, () => queueMicrotask(() => dispatcher.dispatchPending()));
  const worker = new CheckoutWorker(store, inventory, erp, metrics, config.erpTimeoutMs);
  const reconciler = new Reconciler(store, inventory, erp, metrics, config.reconcileStaleAfterMs);
  const server: Server = createHttpServer({ catalog, checkout, store, inventory, metrics });

  queue.subscribe(worker.handle, worker.onDeadLetter);

  return {
    config,
    metrics,
    erp,
    inventory,
    store,
    queue,
    dispatcher,
    catalog,
    checkout,
    worker,
    reconciler,
    server,
    /** Espera o outbox esvaziar e a fila terminar (inclusive retries agendados). */
    async drain(): Promise<void> {
      dispatcher.dispatchPending();
      await queue.idle();
    },
    async close(): Promise<void> {
      dispatcher.stop();
      reconciler.stop();
      queue.close();
      await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
    },
  };
}

export type App = ReturnType<typeof createApp>;
