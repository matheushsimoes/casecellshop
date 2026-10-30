import type { LineItem } from '../inventory/inventory.ts';

export type ValidationResult = { ok: true; items: LineItem[] } | { ok: false; errors: string[] };

const MAX_ITEMS = 20;
const MAX_QUANTITY = 10;

/** Valida o corpo de POST /checkout. Mantido sem dependências; em produção: zod ou o próprio schema OpenAPI. */
export function validateCheckout(body: unknown, knownSku: (sku: string) => boolean): ValidationResult {
  const errors: string[] = [];
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { items?: unknown }).items)) {
    return { ok: false, errors: ['body.items deve ser um array'] };
  }
  const raw = (body as { items: unknown[] }).items;
  if (raw.length === 0 || raw.length > MAX_ITEMS) errors.push(`body.items deve ter entre 1 e ${MAX_ITEMS} itens`);

  const seen = new Set<string>();
  const items: LineItem[] = [];
  raw.forEach((item, i) => {
    const { sku, quantity } = (item ?? {}) as { sku?: unknown; quantity?: unknown };
    if (typeof sku !== 'string' || sku.length === 0) {
      errors.push(`items[${i}].sku é obrigatório`);
      return;
    }
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_QUANTITY) {
      errors.push(`items[${i}].quantity deve ser inteiro entre 1 e ${MAX_QUANTITY}`);
      return;
    }
    if (seen.has(sku)) errors.push(`items[${i}].sku repetido: ${sku}`);
    if (!knownSku(sku)) errors.push(`items[${i}].sku desconhecido: ${sku}`);
    seen.add(sku);
    items.push({ sku, quantity: quantity as number });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, items };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return typeof key === 'string' && (UUID.test(key) || /^[A-Za-z0-9_-]{8,128}$/.test(key));
}
