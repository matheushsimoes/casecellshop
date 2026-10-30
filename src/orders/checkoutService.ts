import { randomUUID } from 'node:crypto';
import type { Inventory, LineItem } from '../inventory/inventory.ts';
import type { Metrics } from '../observability/metrics.ts';
import { currentContext, enrichContext, newCorrelationId, toTraceparent } from '../observability/context.ts';
import { logger } from '../observability/logger.ts';
import { payloadHash, type Order, type OrderStore } from './orderStore.ts';

export type PlaceOrderResult =
  | { kind: 'accepted'; order: Order }
  | { kind: 'replayed'; order: Order }
  | { kind: 'idempotency_conflict' }
  | { kind: 'out_of_stock'; skus: string[] };

/**
 * Aceite do checkout. Tudo entre a checagem da chave de idempotência e a gravação do
 * outbox é síncrono, então duas requisições concorrentes nunca intercalam aqui dentro.
 */
export class CheckoutService {
  private readonly store: OrderStore;
  private readonly inventory: Inventory;
  private readonly metrics: Metrics;
  private readonly onAccepted: () => void;

  constructor(store: OrderStore, inventory: Inventory, metrics: Metrics, onAccepted: () => void) {
    this.store = store;
    this.inventory = inventory;
    this.metrics = metrics;
    this.onAccepted = onAccepted;
  }

  placeOrder(idempotencyKey: string, items: LineItem[]): PlaceOrderResult {
    const hash = payloadHash(items);

    const seen = this.store.findByIdempotencyKey(idempotencyKey);
    if (seen) {
      if (seen.hash !== hash) {
        this.metrics.checkoutRequests.inc({ result: 'idempotency_conflict' });
        return { kind: 'idempotency_conflict' };
      }
      const order = this.store.get(seen.orderId)!;
      enrichContext({ orderId: order.orderId });
      this.metrics.checkoutRequests.inc({ result: 'replayed' });
      logger.info('checkout.replayed', { idempotencyKey });
      return { kind: 'replayed', order: { ...order } };
    }

    const orderId = randomUUID();
    const reservation = this.inventory.reserve(orderId, items);
    if (!reservation.ok) {
      this.metrics.checkoutRequests.inc({ result: 'out_of_stock' });
      logger.info('stock.rejected', { skus: reservation.insufficient });
      return { kind: 'out_of_stock', skus: reservation.insufficient };
    }

    const ctx = currentContext();
    const now = Date.now();
    const order: Order = {
      orderId,
      status: 'PENDING',
      items,
      idempotencyKey,
      correlationId: ctx?.correlationId ?? newCorrelationId(),
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this.store.insertOrderWithOutbox(order, hash, ctx ? toTraceparent(ctx) : '');
    enrichContext({ orderId });
    this.metrics.checkoutRequests.inc({ result: 'accepted' });
    logger.info('order.accepted', { items });

    const accepted = { ...order };
    this.onAccepted();
    return { kind: 'accepted', order: accepted };
  }
}
