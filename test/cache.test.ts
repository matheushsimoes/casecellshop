import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SwrCache } from '../src/catalog/swrCache.ts';
import { createMetrics } from '../src/observability/metrics.ts';
import { startApp } from './helpers.ts';

function makeCache(now: () => number) {
  const metrics = createMetrics();
  const cache = new SwrCache<string>({ name: 'test', ttlMs: 1_000, staleMs: 5_000, jitterRatio: 0, now, metrics });
  return { cache, metrics };
}

describe('SwrCache', () => {
  it('MISS na primeira leitura e HIT dentro do TTL', async () => {
    let t = 0;
    const { cache } = makeCache(() => t);
    let calls = 0;
    const loader = async () => `v${++calls}`;

    assert.equal((await cache.get('k', loader)).status, 'MISS');
    t = 500;
    const hit = await cache.get('k', loader);
    assert.equal(hit.status, 'HIT');
    assert.equal(hit.value, 'v1');
    assert.equal(calls, 1);
  });

  it('depois do TTL serve o valor velho (STALE) e renova em background', async () => {
    let t = 0;
    const { cache } = makeCache(() => t);
    let calls = 0;
    const loader = async () => `v${++calls}`;

    await cache.get('k', loader);
    t = 1_500;
    const stale = await cache.get('k', loader);
    assert.equal(stale.status, 'STALE');
    assert.equal(stale.value, 'v1');
    await new Promise((r) => setImmediate(r));
    const refreshed = await cache.get('k', loader);
    assert.equal(refreshed.status, 'HIT');
    assert.equal(refreshed.value, 'v2');
  });

  it('protege contra cache stampede: 100 leituras simultâneas geram 1 chamada à origem', async () => {
    const { cache, metrics } = makeCache(() => 0);
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 'v';
    };

    const results = await Promise.all(Array.from({ length: 100 }, () => cache.get('k', loader)));
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.value === 'v'));
    assert.equal(metrics.cacheRequests.get({ cache: 'test', result: 'coalesced' }), 99);
  });

  it('stale-if-error: origem fora do ar dentro da janela continua servindo o último valor', async () => {
    let t = 0;
    const { cache, metrics } = makeCache(() => t);
    await cache.get('k', async () => 'v1');
    t = 2_000;
    const result = await cache.get('k', async () => {
      throw new Error('ERP down');
    });
    assert.equal(result.status, 'STALE');
    assert.equal(result.value, 'v1');
    await new Promise((r) => setImmediate(r));
    assert.equal(metrics.cacheOriginErrors.get({ cache: 'test' }), 1);
  });

  it('sem valor utilizável e origem fora do ar: propaga o erro (não inventa dado)', async () => {
    let t = 0;
    const { cache } = makeCache(() => t);
    await cache.get('k', async () => 'v1');
    t = 10_000;
    await assert.rejects(cache.get('k', async () => Promise.reject(new Error('ERP down'))));
  });
});

describe('GET /products', () => {
  it('usa o cache: o ERP é chamado uma vez para várias requisições', async () => {
    const { app, base } = await startApp();
    try {
      const first = await fetch(`${base}/products`);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('x-cache'), 'MISS');
      const body = (await first.json()) as { data: Array<{ sku: string; available: number }> };
      assert.equal(body.data.length, 3);

      const second = await fetch(`${base}/products`);
      assert.equal(second.headers.get('x-cache'), 'HIT');
      assert.equal(app.erp.catalogCalls, 1);
    } finally {
      await app.close();
    }
  });

  it('disponibilidade não fica presa no cache: reflete a reserva na hora', async () => {
    const { app, base, checkout } = await startApp({ stock: { 'CASE-IP15-BLK': 2, 'CASE-IP15-CLR': 1, 'CASE-S24-BLU': 1 } });
    try {
      await fetch(`${base}/products`);
      await checkout([{ sku: 'CASE-IP15-BLK', quantity: 2 }]);
      const body = (await (await fetch(`${base}/products`)).json()) as { data: Array<{ sku: string; inStock: boolean }> };
      assert.equal(body.data.find((p) => p.sku === 'CASE-IP15-BLK')!.inStock, false);
    } finally {
      await app.close();
    }
  });

  it('ERP fora do ar sem cache: 503 com problem+json e correlationId', async () => {
    const { app, base } = await startApp();
    try {
      app.erp.failCatalog = true;
      const res = await fetch(`${base}/products`, { headers: { 'x-correlation-id': 'test-corr-1' } });
      assert.equal(res.status, 503);
      assert.match(res.headers.get('content-type') ?? '', /problem\+json/);
      const body = (await res.json()) as { correlationId: string };
      assert.equal(body.correlationId, 'test-corr-1');
    } finally {
      await app.close();
    }
  });
});
