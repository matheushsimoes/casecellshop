import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CatalogService } from '../catalog/catalogService.ts';
import type { Inventory } from '../inventory/inventory.ts';
import { currentContext, enrichContext, fromTraceparent, newCorrelationId, newSpanId, newTraceId, runWithContext } from '../observability/context.ts';
import { logger } from '../observability/logger.ts';
import { renderMetrics, type Metrics } from '../observability/metrics.ts';
import { withSpan } from '../observability/tracing.ts';
import type { CheckoutService } from '../orders/checkoutService.ts';
import type { Order, OrderStore } from '../orders/orderStore.ts';
import { isValidIdempotencyKey, validateCheckout } from './validation.ts';

export type HttpDeps = {
  catalog: CatalogService;
  checkout: CheckoutService;
  store: OrderStore;
  inventory: Inventory;
  metrics: Metrics;
};

class HttpError extends Error {
  readonly status: number;
  readonly title: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, title: string, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.status = status;
    this.title = title;
    this.extra = extra;
  }
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Payload Too Large', `corpo maior que ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Bad Request', 'JSON inválido');
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const ctx = currentContext();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(ctx ? { 'x-correlation-id': ctx.correlationId } : {}),
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** Erro no formato RFC 7807 (application/problem+json), igual para todas as rotas. */
function sendProblem(res: ServerResponse, err: HttpError): void {
  const ctx = currentContext();
  send(
    res,
    err.status,
    { type: `https://casecellshop.example/problems/${err.status}`, title: err.title, status: err.status, detail: err.message, correlationId: ctx?.correlationId, ...err.extra },
    { 'content-type': 'application/problem+json; charset=utf-8' },
  );
}

const orderView = (o: Order) => ({
  orderId: o.orderId,
  status: o.status,
  items: o.items,
  attempts: o.attempts,
  invoiceId: o.invoiceId ?? null,
  failureReason: o.failureReason ?? null,
  createdAt: new Date(o.createdAt).toISOString(),
  updatedAt: new Date(o.updatedAt).toISOString(),
});

export function createHttpServer(deps: HttpDeps): Server {
  const { catalog, checkout, store, inventory, metrics } = deps;

  async function route(req: IncomingMessage, res: ServerResponse, path: string): Promise<string> {
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') {
      send(res, 200, { status: 'ok' });
      return '/health';
    }

    if (method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics(metrics));
      return '/metrics';
    }

    if (method === 'GET' && path === '/products') {
      try {
        const result = await catalog.listProducts();
        send(res, 200, { data: result.products, meta: { cache: result.cache, dataAgeSeconds: result.dataAgeSeconds } }, { 'x-cache': result.cache });
      } catch {
        throw new HttpError(503, 'Service Unavailable', 'catálogo indisponível: ERP fora do ar e sem cache utilizável', {});
      }
      return '/products';
    }

    if (method === 'POST' && path === '/checkout') {
      const key = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(key) ? key[0] : key;
      if (!isValidIdempotencyKey(idempotencyKey)) {
        throw new HttpError(400, 'Bad Request', 'header Idempotency-Key obrigatório (UUID recomendado)');
      }
      const body = await readJson(req);
      const validation = validateCheckout(body, (sku) => inventory.has(sku));
      if (!validation.ok) {
        metrics.checkoutRequests.inc({ result: 'invalid' });
        throw new HttpError(400, 'Bad Request', 'payload inválido', { errors: validation.errors });
      }

      const result = await withSpan('checkout.place_order', { items: validation.items.length }, () =>
        checkout.placeOrder(idempotencyKey, validation.items),
      );
      switch (result.kind) {
        case 'accepted':
        case 'replayed': {
          enrichContext({ orderId: result.order.orderId });
          const statusUrl = `/orders/${result.order.orderId}/status`;
          send(
            res,
            202,
            { orderId: result.order.orderId, status: result.order.status, statusUrl },
            { location: statusUrl, ...(result.kind === 'replayed' ? { 'idempotent-replayed': 'true' } : {}) },
          );
          break;
        }
        case 'out_of_stock':
          throw new HttpError(409, 'Conflict', 'estoque insuficiente', { skus: result.skus });
        case 'idempotency_conflict':
          throw new HttpError(422, 'Unprocessable Entity', 'Idempotency-Key já usada com outro payload');
      }
      return '/checkout';
    }

    const match = /^\/orders\/([0-9a-f-]{36})\/status$/.exec(path);
    if (method === 'GET' && match) {
      const order = store.get(match[1]!);
      if (!order) throw new HttpError(404, 'Not Found', 'pedido não encontrado');
      send(res, 200, orderView(order));
      return '/orders/{orderId}/status';
    }

    throw new HttpError(404, 'Not Found', `rota ${method} ${path} não existe`);
  }

  return createServer((req, res) => {
    const incoming = req.headers['x-correlation-id'];
    const parent = fromTraceparent(req.headers['traceparent'] as string | undefined);
    const ctx = {
      correlationId: (Array.isArray(incoming) ? incoming[0] : incoming) || newCorrelationId(),
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
    };

    void runWithContext(ctx, async () => {
      const start = performance.now();
      const path = (req.url ?? '/').split('?')[0]!;
      let routeName = 'unmatched';
      try {
        routeName = await route(req, res, path);
      } catch (err) {
        if (err instanceof HttpError) sendProblem(res, err);
        else {
          logger.error('http.unhandled_error', { error: (err as Error).stack });
          sendProblem(res, new HttpError(500, 'Internal Server Error', 'erro inesperado'));
        }
      } finally {
        const durationMs = performance.now() - start;
        metrics.httpRequests.inc({ route: routeName, method: req.method ?? '', status: String(res.statusCode) });
        metrics.httpLatency.observe(durationMs, { route: routeName });
        logger.info('http.request', { method: req.method, route: routeName, httpStatus: res.statusCode, durationMs: Math.round(durationMs * 100) / 100 });
      }
    });
  });
}
