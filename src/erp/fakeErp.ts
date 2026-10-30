import { randomUUID } from 'node:crypto';

export type ErpProduct = { sku: string; name: string; priceCents: number };

/** Comportamento da próxima chamada de faturamento (usado para simular falhas nos testes). */
export type InvoiceBehavior = 'ok' | 'error' | 'timeout' | 'reject';

export class ErpError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'ErpError';
    this.transient = transient;
  }
}

export type FakeErpOptions = {
  products: ErpProduct[];
  latencyMs?: number;
  /** Quanto tempo uma chamada "timeout" fica pendurada antes de responder. */
  hangMs?: number;
  /** Probabilidade de erro transitório no faturamento (0 a 1), para a demo local. */
  invoiceErrorRate?: number;
};

const sleep = (ms: number, unref = false) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (unref) t.unref();
  });

/**
 * ERP simulado. Representa o monolito que não podemos alterar:
 * - catálogo lento (latência configurável);
 * - faturamento lento e instável: pode falhar, rejeitar ou demorar além do timeout.
 *
 * O faturamento é idempotente por orderId: chamar duas vezes devolve a mesma nota.
 * No mundo real, se o ERP não oferecer isso, o worker consulta `findInvoice` antes de
 * refaturar, que é o que a reconciliação faz.
 */
export class FakeErp {
  readonly products: ErpProduct[];
  catalogCalls = 0;
  invoiceCalls = 0;
  failCatalog = false;
  private readonly latencyMs: number;
  private readonly hangMs: number;
  private readonly invoiceErrorRate: number;
  private readonly invoices = new Map<string, string>();
  private readonly script: InvoiceBehavior[] = [];

  constructor(opts: FakeErpOptions) {
    this.products = opts.products;
    this.latencyMs = opts.latencyMs ?? 0;
    this.hangMs = opts.hangMs ?? 30_000;
    this.invoiceErrorRate = opts.invoiceErrorRate ?? 0;
  }

  /** Define o comportamento das próximas chamadas de faturamento, em ordem. */
  scriptInvoice(...behaviors: InvoiceBehavior[]): void {
    this.script.push(...behaviors);
  }

  async getProducts(): Promise<ErpProduct[]> {
    this.catalogCalls++;
    await sleep(this.latencyMs);
    if (this.failCatalog) throw new ErpError('ERP catalog unavailable', true);
    return structuredClone(this.products);
  }

  async invoice(orderId: string): Promise<{ invoiceId: string }> {
    this.invoiceCalls++;
    const behavior = this.script.shift() ?? (Math.random() < this.invoiceErrorRate ? 'error' : 'ok');
    await sleep(this.latencyMs);
    if (behavior === 'error') throw new ErpError('ERP returned 503', true);
    if (behavior === 'reject') throw new ErpError('ERP rejected the order (422)', false);
    const invoiceId = this.invoices.get(orderId) ?? `NF-${randomUUID().slice(0, 8)}`;
    this.invoices.set(orderId, invoiceId);
  
    if (behavior === 'timeout') await sleep(this.hangMs, true);
    return { invoiceId };
  }

  async findInvoice(orderId: string): Promise<string | undefined> {
    await sleep(this.latencyMs);
    return this.invoices.get(orderId);
  }

  invoiceCount(): number {
    return this.invoices.size;
  }
}
