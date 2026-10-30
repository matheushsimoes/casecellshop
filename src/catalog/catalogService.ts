import type { ErpProduct, FakeErp } from '../erp/fakeErp.ts';
import type { Inventory } from '../inventory/inventory.ts';
import type { Metrics } from '../observability/metrics.ts';
import { withSpan } from '../observability/tracing.ts';
import { SwrCache, type CacheStatus } from './swrCache.ts';

export type ProductView = { sku: string; name: string; priceCents: number; available: number; inStock: boolean };
export type CatalogResult = { products: ProductView[]; cache: CacheStatus; dataAgeSeconds: number };

export class CatalogService {
  private readonly cache: SwrCache<ErpProduct[]>;
  private readonly erp: FakeErp;
  private readonly inventory: Inventory;
  private readonly metrics: Metrics;

  constructor(erp: FakeErp, inventory: Inventory, metrics: Metrics, cache: SwrCache<ErpProduct[]>) {
    this.erp = erp;
    this.inventory = inventory;
    this.metrics = metrics;
    this.cache = cache;
  }

  async listProducts(): Promise<CatalogResult> {
    const result = await withSpan('cache.get', { key: 'catalog:v1' }, () =>
      this.cache.get('catalog:v1', () => this.fetchFromErp()),
    );
    const products = result.value.map((p) => {
      const stock = this.inventory.snapshot(p.sku);
      return { ...p, available: stock.available, inStock: stock.available > 0 };
    });
    return { products, cache: result.status, dataAgeSeconds: Math.round(result.ageSeconds * 10) / 10 };
  }

  /** Chamado por um evento de mudança de preço vindo da sincronização com o ERP. */
  invalidate(): void {
    this.cache.invalidate('catalog:v1');
  }

  private fetchFromErp(): Promise<ErpProduct[]> {
    return withSpan('erp.getProducts', {}, async () => {
      const start = performance.now();
      try {
        const products = await this.erp.getProducts();
        this.metrics.erpCalls.inc({ op: 'getProducts', result: 'ok' });
        return products;
      } catch (err) {
        this.metrics.erpCalls.inc({ op: 'getProducts', result: 'error' });
        throw err;
      } finally {
        this.metrics.erpLatency.observe(performance.now() - start, { op: 'getProducts' });
      }
    });
  }
}
