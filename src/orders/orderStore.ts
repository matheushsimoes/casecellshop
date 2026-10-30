import { createHash, randomUUID } from 'node:crypto';
import type { LineItem } from '../inventory/inventory.ts';

export type OrderStatus = 'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED';

export type Order = {
  orderId: string;
  status: OrderStatus;
  items: LineItem[];
  idempotencyKey: string;
  correlationId: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  invoiceId?: string;
  failureReason?: string;
};

export type OutboxMessage = {
  id: string;
  type: 'OrderAccepted';
  orderId: string;
  correlationId: string;
  traceparent: string;
  status: 'PENDING' | 'SENT';
  createdAt: number;
};

/** Hash canônico do payload: a mesma chave de idempotência com outro conteúdo é rejeitada. */
export function payloadHash(items: LineItem[]): string {
  const canonical = [...items].sort((a, b) => a.sku.localeCompare(b.sku)).map((i) => `${i.sku}:${i.quantity}`).join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Repositório em memória de pedidos, chaves de idempotência e outbox.
 * Equivale a três tabelas: orders, idempotency_keys (UNIQUE em key) e outbox.
 */
export class OrderStore {
  readonly orders = new Map<string, Order>();
  readonly idempotency = new Map<string, { hash: string; orderId: string }>();
  readonly outbox: OutboxMessage[] = [];

  get(orderId: string): Order | undefined {
    return this.orders.get(orderId);
  }

  findByIdempotencyKey(key: string): { hash: string; orderId: string } | undefined {
    return this.idempotency.get(key);
  }

  /**
   * "Transação": grava pedido + chave de idempotência + mensagem no outbox juntos.
   * Síncrono de propósito (nenhum await): ou tudo acontece, ou nada.
   * Em banco real: BEGIN; INSERT orders; INSERT idempotency_keys; INSERT outbox; COMMIT.
   */
  insertOrderWithOutbox(order: Order, hash: string, traceparent: string): void {
    this.orders.set(order.orderId, order);
    this.idempotency.set(order.idempotencyKey, { hash, orderId: order.orderId });
    this.enqueueOutbox(order, traceparent);
  }

  enqueueOutbox(order: Order, traceparent: string): void {
    this.outbox.push({
      id: randomUUID(),
      type: 'OrderAccepted',
      orderId: order.orderId,
      correlationId: order.correlationId,
      traceparent,
      status: 'PENDING',
      createdAt: Date.now(),
    });
  }

  update(orderId: string, patch: Partial<Order>): Order | undefined {
    const order = this.orders.get(orderId);
    if (!order) return undefined;
    Object.assign(order, patch, { updatedAt: Date.now() });
    return order;
  }
}
