import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startApp } from './helpers.ts';

type Accepted = { orderId: string };

describe('Resiliência do checkout assíncrono', () => {
  it('erros transitórios: tenta de novo com backoff e confirma', async () => {
    const { app, checkout } = await startApp();
    try {
      app.erp.scriptInvoice('error', 'error', 'ok');
      const { orderId } = (await (await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }])).json()) as Accepted;
      await app.drain();
      const order = app.store.get(orderId)!;
      assert.equal(order.status, 'CONFIRMED');
      assert.equal(order.attempts, 3);
      assert.equal(app.metrics.queueRetries.get(), 2);
    } finally {
      await app.close();
    }
  });

  it('timeout com resultado desconhecido: o retry não gera nota duplicada (idempotência no ERP)', async () => {
    const { app, checkout } = await startApp();
    try {
      app.erp.scriptInvoice('timeout', 'ok');
      const { orderId } = (await (await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }])).json()) as Accepted;
      await app.drain();
      assert.equal(app.store.get(orderId)!.status, 'CONFIRMED');
      assert.equal(app.erp.invoiceCalls, 2);
      assert.equal(app.erp.invoiceCount(), 1);
      assert.equal(app.metrics.erpCalls.get({ op: 'invoice', result: 'timeout' }), 1);
    } finally {
      await app.close();
    }
  });

  it('falha persistente: vai para a DLQ, pedido FAILED e estoque liberado', async () => {
    const { app, checkout } = await startApp({ queueMaxAttempts: 3 });
    try {
      app.erp.scriptInvoice('error', 'error', 'error');
      const { orderId } = (await (await checkout([{ sku: 'CASE-IP15-BLK', quantity: 2 }])).json()) as Accepted;
      await app.drain();
      const order = app.store.get(orderId)!;
      assert.equal(order.status, 'FAILED');
      assert.equal(app.queue.dlq.length, 1);
      assert.deepEqual(app.inventory.snapshot('CASE-IP15-BLK'), { available: 10, reserved: 0, sold: 0 });
    } finally {
      await app.close();
    }
  });

  it('erro permanente (ERP rejeita): DLQ na primeira tentativa, sem retries inúteis', async () => {
    const { app, checkout } = await startApp();
    try {
      app.erp.scriptInvoice('reject');
      const { orderId } = (await (await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }])).json()) as Accepted;
      await app.drain();
      assert.equal(app.store.get(orderId)!.status, 'FAILED');
      assert.equal(app.erp.invoiceCalls, 1);
      assert.equal(app.metrics.queueRetries.get(), 0);
    } finally {
      await app.close();
    }
  });

  it('mensagem duplicada (at-least-once) é ignorada pelo worker', async () => {
    const { app, checkout } = await startApp();
    try {
      const { orderId } = (await (await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }])).json()) as Accepted;
      await app.drain();
      const order = app.store.get(orderId)!;
      app.queue.publish({ orderId, correlationId: order.correlationId, traceparent: '' });
      await app.drain();
      assert.equal(app.erp.invoiceCalls, 1);
      assert.equal(app.inventory.snapshot('CASE-IP15-BLK').sold, 1);
    } finally {
      await app.close();
    }
  });
});

describe('Reconciliação com o ERP', () => {
  it('pedido parado que o ERP já faturou é confirmado', async () => {
    const { app } = await startApp({ reconcileStaleAfterMs: 0 });
    try {
      const orderId = '11111111-1111-4111-8111-111111111111';
      app.inventory.reserve(orderId, [{ sku: 'CASE-IP15-BLK', quantity: 1 }]);
      const now = Date.now();
      app.store.orders.set(orderId, { orderId, status: 'PROCESSING', items: [{ sku: 'CASE-IP15-BLK', quantity: 1 }], idempotencyKey: 'k-recon-1', correlationId: 'c', createdAt: now, updatedAt: now, attempts: 1 });
      await app.erp.invoice(orderId);

      const result = await app.reconciler.run(Date.now() + 1);
      assert.equal(result.confirmed, 1);
      assert.equal(app.store.get(orderId)!.status, 'CONFIRMED');
      assert.equal(app.inventory.snapshot('CASE-IP15-BLK').sold, 1);
    } finally {
      await app.close();
    }
  });

  it('pedido parado sem nota no ERP volta para o outbox e é processado', async () => {
    const { app } = await startApp({ reconcileStaleAfterMs: 0 });
    try {
      const orderId = '22222222-2222-4222-8222-222222222222';
      app.inventory.reserve(orderId, [{ sku: 'CASE-IP15-BLK', quantity: 1 }]);
      const now = Date.now();
      app.store.orders.set(orderId, { orderId, status: 'PENDING', items: [{ sku: 'CASE-IP15-BLK', quantity: 1 }], idempotencyKey: 'k-recon-2', correlationId: 'c', createdAt: now, updatedAt: now, attempts: 0 });

      const result = await app.reconciler.run(Date.now() + 1);
      assert.equal(result.requeued, 1);
      await app.drain();
      assert.equal(app.store.get(orderId)!.status, 'CONFIRMED');
    } finally {
      await app.close();
    }
  });
});

describe('Observabilidade', () => {
  it('expõe métricas de cache, checkout, fila e ERP em /metrics', async () => {
    const { app, base, checkout } = await startApp();
    try {
      await fetch(`${base}/products`);
      await checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }]);
      await app.drain();
      const text = await (await fetch(`${base}/metrics`)).text();
      assert.match(text, /cache_requests_total\{cache="catalog",result="miss"\} 1/);
      assert.match(text, /checkout_requests_total\{result="accepted"\} 1/);
      assert.match(text, /erp_calls_total\{op="invoice",result="ok"\} 1/);
      assert.match(text, /orders_finished_total\{status="CONFIRMED"\} 1/);
      assert.match(text, /http_request_duration_ms_bucket/);
    } finally {
      await app.close();
    }
  });

  it('propaga o correlationId recebido na resposta', async () => {
    const { app, base } = await startApp();
    try {
      const res = await fetch(`${base}/health`, { headers: { 'x-correlation-id': 'abc-123' } });
      assert.equal(res.headers.get('x-correlation-id'), 'abc-123');
    } finally {
      await app.close();
    }
  });
});
