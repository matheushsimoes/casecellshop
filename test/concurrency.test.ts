import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startApp } from './helpers.ts';

describe('Concorrência: sem overselling', () => {
  it('100 checkouts simultâneos para estoque 10: exatamente 10 aceitos, 90 recusados, nunca negativo', async () => {
    const { app, checkout } = await startApp({ stock: { 'CASE-IP15-BLK': 10, 'CASE-IP15-CLR': 0, 'CASE-S24-BLU': 0 } });
    try {
      const responses = await Promise.all(Array.from({ length: 100 }, () => checkout([{ sku: 'CASE-IP15-BLK', quantity: 1 }])));
      const statuses = responses.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 202).length, 10);
      assert.equal(statuses.filter((s) => s === 409).length, 90);

      await app.drain();
      const stock = app.inventory.snapshot('CASE-IP15-BLK');
      assert.deepEqual(stock, { available: 0, reserved: 0, sold: 10 });
      assert.equal(stock.sold + stock.reserved + stock.available, 10);
    } finally {
      await app.close();
    }
  });

  it('pedidos com vários itens reservam tudo ou nada', async () => {
    const { app, checkout } = await startApp({ stock: { 'CASE-IP15-BLK': 5, 'CASE-IP15-CLR': 1, 'CASE-S24-BLU': 0 } });
    try {
      const items = [
        { sku: 'CASE-IP15-BLK', quantity: 1 },
        { sku: 'CASE-IP15-CLR', quantity: 1 },
      ];
      const responses = await Promise.all(Array.from({ length: 5 }, () => checkout(items)));
      assert.equal(responses.filter((r) => r.status === 202).length, 1);
      assert.equal(app.inventory.snapshot('CASE-IP15-BLK').available, 4);
    } finally {
      await app.close();
    }
  });

  it('controle: o mesmo teste pega o bug de uma implementação check-then-act', async () => {
    let available = 10;
    const naiveReserve = async () => {
      if (available < 1) return false;
      await new Promise((r) => setTimeout(r, 1));
      available -= 1;
      return true;
    };
    const results = await Promise.all(Array.from({ length: 100 }, naiveReserve));
    const accepted = results.filter(Boolean).length;
    assert.ok(accepted > 10, `esperado overselling na versão ingênua, aceitou ${accepted}`);
    assert.ok(available < 0);
  });
});
