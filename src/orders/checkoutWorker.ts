import { ErpError, type FakeErp } from '../erp/fakeErp.ts';
import type { Inventory } from '../inventory/inventory.ts';
import { PermanentError, RetryableError, type DeadLetter, type QueueMessage } from '../messaging/queue.ts';
import { fromTraceparent, newSpanId, newTraceId, runWithContext } from '../observability/context.ts';
import { logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { withSpan } from '../observability/tracing.ts';
import type { OrderStore } from './orderStore.ts';

export class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`ERP timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Worker que envia o pedido para faturamento no ERP.
 * - Idempotente: se o pedido já está CONFIRMED ou FAILED, a mensagem repetida é ignorada.
 * - Timeout: tratado como transitório. Como o faturamento é idempotente por orderId,
 *   repetir depois de um timeout de resultado desconhecido não gera nota duplicada.
 * - Erros: transitórios voltam para a fila (backoff); permanentes vão para a DLQ.
 */
export class CheckoutWorker {
  private readonly store: OrderStore;
  private readonly inventory: Inventory;
  private readonly erp: FakeErp;
  private readonly metrics: Metrics;
  private readonly erpTimeoutMs: number;

  constructor(store: OrderStore, inventory: Inventory, erp: FakeErp, metrics: Metrics, erpTimeoutMs: number) {
    this.store = store;
    this.inventory = inventory;
    this.erp = erp;
    this.metrics = metrics;
    this.erpTimeoutMs = erpTimeoutMs;
  }

  handle = (msg: QueueMessage): Promise<void> => {
    const parent = fromTraceparent(msg.traceparent);
    const ctx = { correlationId: msg.correlationId, traceId: parent?.traceId ?? newTraceId(), spanId: newSpanId(), orderId: msg.orderId };
    return runWithContext(ctx, () =>
      withSpan('worker.process', { attempt: msg.attempt, parentSpanId: parent?.parentSpanId }, () => this.process(msg)),
    );
  };

  onDeadLetter = (dead: DeadLetter): void => {
    const { orderId } = dead.message;
    runWithContext({ correlationId: dead.message.correlationId, traceId: newTraceId(), spanId: newSpanId(), orderId }, () => {
      const order = this.store.get(orderId);
      if (!order || order.status === 'CONFIRMED' || order.status === 'FAILED') return;
      this.store.update(orderId, { status: 'FAILED', failureReason: dead.reason });
      this.inventory.release(orderId);
      this.metrics.ordersFinished.inc({ status: 'FAILED' });
      logger.error('order.dead_lettered', { reason: dead.reason, attempts: dead.message.attempt });
    });
  };

  private async process(msg: QueueMessage): Promise<void> {
    const order = this.store.get(msg.orderId);
    if (!order) {
      logger.warn('worker.order_not_found');
      return;
    }
    if (order.status === 'CONFIRMED' || order.status === 'FAILED') {
      logger.info('worker.duplicate_ignored', { status: order.status });
      return;
    }

    this.store.update(order.orderId, { status: 'PROCESSING', attempts: order.attempts + 1 });
    logger.info('erp.invoice.attempt', { attempt: msg.attempt });

    const start = performance.now();
    try {
      const { invoiceId } = await withSpan('erp.invoice', { attempt: msg.attempt }, () =>
        withTimeout(this.erp.invoice(order.orderId), this.erpTimeoutMs),
      );
      this.metrics.erpCalls.inc({ op: 'invoice', result: 'ok' });
      this.inventory.confirm(order.orderId);
      const updated = this.store.update(order.orderId, { status: 'CONFIRMED', invoiceId })!;
      this.metrics.ordersFinished.inc({ status: 'CONFIRMED' });
      this.metrics.orderEndToEnd.observe(updated.updatedAt - updated.createdAt);
      logger.info('erp.invoice.succeeded', { invoiceId, attempt: msg.attempt });
    } catch (err) {
      const result = err instanceof TimeoutError ? 'timeout' : 'error';
      this.metrics.erpCalls.inc({ op: 'invoice', result });
      logger.warn('erp.invoice.failed', { attempt: msg.attempt, error: (err as Error).message, result });
      if (err instanceof ErpError && !err.transient) throw new PermanentError((err as Error).message);
      throw new RetryableError((err as Error).message);
    } finally {
      this.metrics.erpLatency.observe(performance.now() - start, { op: 'invoice' });
      this.metrics.workerProcessing.observe(performance.now() - start);
    }
  }
}
