import type { Metrics } from '../observability/metrics.ts';

export type LineItem = { sku: string; quantity: number };
export type ReserveResult = { ok: true } | { ok: false; insufficient: string[] };

type Stock = { available: number; reserved: number; sold: number };
type Reservation = { items: LineItem[]; state: 'HELD' | 'CONFIRMED' | 'RELEASED' };

/**
 * Estoque próprio da loja (o ERP continua sendo o sistema de registro contábil;
 * a loja controla o que pode VENDER e reconcilia com o ERP).
 *
 * `reserve` é a simulação do atomic update condicional:
 *   UPDATE stock SET available = available - :q, reserved = reserved + :q
 *   WHERE sku = :sku AND available >= :q
 * executado para todos os itens numa única transação.
 *
 * Aqui a atomicidade vem do fato de o método ser 100% síncrono: no Node.js nenhuma outra
 * requisição roda no meio de um bloco sem `await`. Com várias instâncias, essa garantia
 * precisa vir do banco (o UPDATE acima) — ver README, seção Limitações.
 */
export class Inventory {
  private readonly stock = new Map<string, Stock>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly metrics: Metrics;

  constructor(initial: Record<string, number>, metrics: Metrics) {
    this.metrics = metrics;
    for (const [sku, qty] of Object.entries(initial)) this.stock.set(sku, { available: qty, reserved: 0, sold: 0 });
  }

  has(sku: string): boolean {
    return this.stock.has(sku);
  }

  snapshot(sku: string): Stock {
    const s = this.stock.get(sku);
    return s ? { ...s } : { available: 0, reserved: 0, sold: 0 };
  }

  
  reserve(orderId: string, items: LineItem[]): ReserveResult {
    if (this.reservations.has(orderId)) return { ok: true };

    const insufficient = items.filter((i) => (this.stock.get(i.sku)?.available ?? 0) < i.quantity).map((i) => i.sku);
    if (insufficient.length > 0) {
      this.metrics.stockReservations.inc({ result: 'insufficient' });
      return { ok: false, insufficient };
    }
    for (const i of items) {
      const s = this.stock.get(i.sku)!;
      s.available -= i.quantity;
      s.reserved += i.quantity;
    }
    this.reservations.set(orderId, { items, state: 'HELD' });
    this.metrics.stockReservations.inc({ result: 'reserved' });
    return { ok: true };
  }

  /** Pedido faturado: a reserva vira venda. Idempotente. */
  confirm(orderId: string): void {
    const r = this.reservations.get(orderId);
    if (!r || r.state !== 'HELD') return;
    for (const i of r.items) {
      const s = this.stock.get(i.sku)!;
      s.reserved -= i.quantity;
      s.sold += i.quantity;
    }
    r.state = 'CONFIRMED';
  }

  /** Pedido falhou: devolve o estoque. Idempotente. */
  release(orderId: string): void {
    const r = this.reservations.get(orderId);
    if (!r || r.state !== 'HELD') return;
    for (const i of r.items) {
      const s = this.stock.get(i.sku)!;
      s.reserved -= i.quantity;
      s.available += i.quantity;
    }
    r.state = 'RELEASED';
  }
}
