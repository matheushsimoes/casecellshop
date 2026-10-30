import type { OrderStore } from '../orders/orderStore.ts';
import type { InMemoryQueue } from './queue.ts';

/**
 * Transactional Outbox: o checkout grava a mensagem no banco junto com o pedido;
 * este dispatcher publica na fila e marca como enviada.
 * - Pedido fantasma (gravado sem mensagem) não acontece: a mensagem está na mesma transação.
 * - Mensagem fantasma (mensagem sem pedido) não acontece: só se publica o que foi gravado.
 * - Se o processo cair entre publicar e marcar SENT, a mensagem sai duas vezes:
 *   por isso o worker é idempotente.
 * Em produção: polling com SELECT ... FOR UPDATE SKIP LOCKED, ou CDC (Debezium).
 */
export class OutboxDispatcher {
  private readonly store: OrderStore;
  private readonly queue: InMemoryQueue;
  private timer?: NodeJS.Timeout;

  constructor(store: OrderStore, queue: InMemoryQueue) {
    this.store = store;
    this.queue = queue;
  }

  dispatchPending(): number {
    let sent = 0;
    for (const msg of this.store.outbox) {
      if (msg.status !== 'PENDING') continue;
      this.queue.publish({ orderId: msg.orderId, correlationId: msg.correlationId, traceparent: msg.traceparent });
      msg.status = 'SENT';
      sent++;
    }
    return sent;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => this.dispatchPending(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
