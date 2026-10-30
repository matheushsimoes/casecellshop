import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { startApp } from './helpers.ts';

type Accepted = { orderId: string; status: string; statusUrl: string };
type Status = { orderId: string; status: string; attempts: number; invoiceId: string | null; failureReason: string | null };

describe('POST /checkout e GET /orders/{id}/status', () => {
  it('aceita com 202, devolve orderId e Location, e o pedido chega a CONFIRMED', async () => {
    const { app, base, checkout } = await startApp();
    try {
      const res = await checkout([{ sku: 'CASE-IP15-BLK', quantity: 2 }]);
      assert.equal(res.status, 202);
      const body = (await res.json()) as Accepted;
      assert.equal(body.status, 'PENDING');
      assert.equal(res.headers.get('location'), `/orders/${body.orderId}/status`);

      await app.drain();
      const status = (await (await fetch(`${base}${body.statusUrl}`)).json()) as Status;
      assert.equal(status.status, 'CONFIRMED');
      assert.ok(status.invoiceId);
      assert.deepEqual(app.inventory.snapshot('CASE-IP15-BLK'), { available: 8, reserved: 0, sold: 2 });
    } finally {
      await app.close();
    }
  });

  it('rejeita sem Idempotency-Key (400) e com payload inválido (400)', async () => {
    const { app, base, checkout } = await startApp();
    try {
      const noKey = await fetch(`${base}/checkout`, { method: 'POST', body: JSON.stringify({ items: [] }) });
      assert.equal(noKey.status, 400);

      const invalid = await checkout([{ sku: 'NAO-EXISTE', quantity: 0 }]);
      assert.equal(invalid.status, 400);
      const problem = (await invalid.json()) as { errors: string[] };
      assert.ok(problem.errors.length > 0);
    } finally {
      await app.close();
    }
  });

  it('devolve 409 quando não há estoque', async () => {
    const { app, checkout } = await startApp();
    try {
      const res = await checkout([{ sku: 'CASE-S24-BLU', quantity: 4 }]);
      assert.equal(res.status, 409);
      const body = (await res.json()) as { skus: string[] };
      assert.deepEqual(body.skus, ['CASE-S24-BLU']);
    } finally {
      await app.close();
    }
  });

  it('404 para pedido inexistente', async () => {
    const { app, base } = await startApp();
    try {
      const res = await fetch(`${base}/orders/${randomUUID()}/status`);
      assert.equal(res.status, 404);
    } finally {
      await app.close();
    }
  });
});

describe('Idempotência', () => {
  it('mesma chave e mesmo payload: devolve o mesmo pedido, sem nova reserva', async () => {
    const { app, checkout } = await startApp();
    try {
      const key = randomUUID();
      const items = [{ sku: 'CASE-IP15-BLK', quantity: 1 }];
      const a = (await (await checkout(items, key)).json()) as Accepted;
      const second = await checkout(items, key);
      const b = (await second.json()) as Accepted;
      assert.equal(second.status, 202);
      assert.equal(second.headers.get('idempotent-replayed'), 'true');
      assert.equal(a.orderId, b.orderId);
      assert.equal(app.store.orders.size, 1);
      assert.equal(app.inventory.snapshot('CASE-IP15-BLK').available, 9);
    } finally {
      await app.close();
    }
  });

  it('mesma chave com payload diferente: 422', async () => {
    const { app, checkout } = await startApp();
    try {
      const key = randomUUID();
      await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }], key);
      const res = await checkout([{ sku: 'CASE-IP15-BLK', quantity: 2 }], key);
      assert.equal(res.status, 422);
    } finally {
      await app.close();
    }
  });

  it('duplo clique: 20 requisições simultâneas com a mesma chave criam 1 pedido', async () => {
    const { app, checkout } = await startApp();
    try {
      const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 20 }, () => checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }], key)));
      const ids = new Set(await Promise.all(responses.map(async (r) => ((await r.json()) as Accepted).orderId)));
      assert.equal(ids.size, 1);
      assert.equal(app.store.orders.size, 1);
      assert.equal(app.inventory.snapshot('CASE-IP15-BLK').available, 9);
    } finally {
      await app.close();
    }
  });
});
