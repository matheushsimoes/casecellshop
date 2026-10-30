import type { FakeErp } from '../erp/fakeErp.ts';
import type { Inventory } from '../inventory/inventory.ts';
import { newCorrelationId, newSpanId, newTraceId, runWithContext, toTraceparent } from '../observability/context.ts';
import { logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { OrderStore } from './orderStore.ts';

/**
 * Reconciliação com o ERP: a rede de segurança para o que escapou do fluxo normal
 * (mensagem perdida, worker que caiu no meio, timeout cujo resultado nunca foi lido).
 *
 * Para cada pedido parado em PENDING/PROCESSING há mais de `staleAfterMs`:
 * - se o ERP já tem nota para o pedido → confirma (o ERP é a fonte de verdade do faturamento);
 * - se não tem → recoloca no outbox para nova tentativa.
 */
export class Reconciler {
  private readonly store: OrderStore;
  private readonly inventory: Inventory;
  private readonly erp: FakeErp;
  private readonly metrics: Metrics;
  private readonly staleAfterMs: number;
  private timer?: NodeJS.Timeout;

  constructor(store: OrderStore, inventory: Inventory, erp: FakeErp, metrics: Metrics, staleAfterMs: number) {
    this.store = store;
    this.inventory = inventory;
    this.erp = erp;
    this.metrics = metrics;
    this.staleAfterMs = staleAfterMs;
  }

  async run(now = Date.now()): Promise<{ confirmed: number; requeued: number }> {
    let confirmed = 0;
    let requeued = 0;
    for (const order of this.store.orders.values()) {
      if (order.status !== 'PENDING' && order.status !== 'PROCESSING') continue;
      if (now - order.updatedAt < this.staleAfterMs) continue;

      const ctx = { correlationId: order.correlationId ?? newCorrelationId(), traceId: newTraceId(), spanId: newSpanId(), orderId: order.orderId };
      await runWithContext(ctx, async () => {
        const invoiceId = await this.erp.findInvoice(order.orderId);
        if (invoiceId) {
          this.inventory.confirm(order.orderId);
          this.store.update(order.orderId, { status: 'CONFIRMED', invoiceId });
          this.metrics.reconciliationFixes.inc({ action: 'confirmed' });
          this.metrics.ordersFinished.inc({ status: 'CONFIRMED' });
          logger.warn('reconciliation.confirmed_from_erp', { invoiceId });
          confirmed++;
        } else {
          this.store.update(order.orderId, {});
          this.store.enqueueOutbox(order, toTraceparent(ctx));
          this.metrics.reconciliationFixes.inc({ action: 'requeued' });
          logger.warn('reconciliation.requeued', { status: order.status });
          requeued++;
        }
      });
    }
    return { confirmed, requeued };
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
