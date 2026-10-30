# CaseCellShop —==

Serviço pequeno e executável que demonstra as decisões pedidas no case:

- `GET /products` com **cache** (TTL, single-flight contra stampede, stale-while-revalidate e stale-if-error);
- `POST /checkout` **assíncrono**: reserva atômica de estoque, idempotência, outbox, fila com retry e DLQ;
- `GET /orders/{orderId}/status` para acompanhar o processamento;
- **observabilidade**: logs JSON com `correlationId`/`traceId`/`orderId`, métricas Prometheus em `/metrics` e trace propagado da requisição até o worker;
- **reconciliação** com o ERP para pedidos com status incerto.

## Como rodar

Requisito: **Node.js 22.18+** (executa TypeScript nativamente). **Não há dependências para instalar.**

```bash
npm start          # sobe a API em http://localhost:3000
npm test           # 27 testes: regra de negócio, cache, concorrência, resiliência e observabilidade
npm run typecheck  # opcional: requer `typescript` e `@types/node` instalados globalmente
```

Variáveis úteis: `PORT`, `LOG_LEVEL=debug` (mostra os spans), `ERP_ERROR_RATE` (padrão 0.3, para ver retries), `ERP_LATENCY_MS`.

```bash
curl -i localhost:3000/products                       # x-cache: MISS, depois HIT
curl -i -X POST localhost:3000/checkout \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 6f1c2a1e-0000-4000-8000-000000000001' \
  -d '{"items":[{"sku":"CASE-IP15-BLK","quantity":2}]}' # 202 + Location
curl localhost:3000/orders/<orderId>/status            # PENDING → PROCESSING → CONFIRMED | FAILED
curl localhost:3000/metrics
```

O contrato completo está em [`openapi.yaml`](openapi.yaml).

### Por que sem dependências

Minha stack preferida é Node.js + TypeScript. Usei só a biblioteca padrão (`node:http`, `node:test`, `AsyncLocalStorage`) para que o projeto rode com um comando, sem `npm install` nem infraestrutura. Em produção, as peças equivalentes seriam: Fastify/Express, zod, Redis, PostgreSQL, SQS ou RabbitMQ, pino, prom-client e OpenTelemetry com exportador para o Datadog. As interfaces foram desenhadas para essa troca ser local (ver "Do protótipo para produção").

## Arquitetura

```
              ┌──────────── GET /products ────────────┐
Cliente ──►  API ── SwrCache (TTL + single-flight + stale) ──► ERP.getProducts
              │        └─ disponibilidade lida do Inventory da loja (tempo real)
              │
              └── POST /checkout
                    1. Idempotency-Key (hash do payload)
                    2. Inventory.reserve  ← atomic update condicional, tudo ou nada
                    3. Order + outbox na mesma "transação"
                    4. 202 Accepted + Location
                          │
            OutboxDispatcher ──► InMemoryQueue ──► CheckoutWorker ──► ERP.invoice (timeout)
                                   │  retry exponencial + jitter            │
                                   └──► DLQ ─► pedido FAILED + estoque liberado
            Reconciler (periódico): pedidos parados ──► ERP.findInvoice ──► confirma ou reenfileira
```

Estados do pedido: `PENDING` → `PROCESSING` → `CONFIRMED` | `FAILED`.

## Decisões e trade-offs

| Tema | Decisão | Trade-off |
| --- | --- | --- |
| Cache da vitrine | Nome e preço em cache (TTL 30 s, janela stale 120 s, jitter ±10%). Disponibilidade **fora** do cache, lida do estoque da loja | Preço pode ficar até 30 s desatualizado (aceitável na vitrine; o checkout usaria o preço vigente). Disponibilidade nunca mente por causa do cache |
| Stampede | Single-flight por chave: N leituras simultâneas = 1 chamada ao ERP | Em memória vale por instância; entre instâncias, lock no Redis (`SET NX PX`) |
| ERP fora do ar | stale-if-error dentro da janela; sem dado utilizável → 503 | Preferi **não inventar dado** a mostrar preço muito antigo |
| Overselling | `reserve` = atomic update condicional, todos os itens ou nenhum | Linha quente em SKUs muito disputados; alternativa: contador no Redis (Lua) |
| Idempotência | `Idempotency-Key` obrigatória + hash do payload. Mesma chave e payload → mesmo pedido (202 + `Idempotent-Replayed`); payload diferente → 422 | Chave fica guardada (em produção, TTL de 24 h) |
| Dual write | Transactional outbox: pedido + mensagem gravados juntos; dispatcher publica | Entrega *at-least-once*, por isso o worker é idempotente |
| Retry | Backoff exponencial com full jitter; erro permanente (4xx do ERP) vai direto para a DLQ | Pedido pode levar minutos para confirmar em instabilidade do ERP; o cliente acompanha pelo status |
| Timeout do ERP | Tratado como resultado desconhecido: retry é seguro porque o faturamento é idempotente por `orderId` | Se o ERP real não for idempotente, consultar `findInvoice` antes de refaturar |
| Falha definitiva | DLQ → pedido `FAILED` + estoque **liberado** | Reserva não fica presa |
| Status incerto | Reconciliação periódica: confirma pelo ERP ou reenfileira | Roda a cada 60 s para pedidos parados há mais de 5 min |
| Tracing | Stub com a mesma semântica do OpenTelemetry (traceId, spanId, parentSpanId, `traceparent` na mensagem) | Spans saem como log `span.end`; trocar por `@opentelemetry/api` não muda a estrutura |

## Testes

`npm test` roda 27 testes com `node:test`:

- **Cache:** MISS → HIT, STALE + revalidação, 100 leituras simultâneas = 1 chamada à origem, stale-if-error, erro quando não há dado utilizável, disponibilidade em tempo real.
- **Checkout e contrato:** 202 + `Location`, 400, 404, 409 e 422 no formato RFC 7807.
- **Idempotência:** replay, conflito de payload e 20 requisições simultâneas com a mesma chave = 1 pedido.
- **Concorrência:** 100 checkouts para estoque 10 → exatamente 10 aceitos e invariante `vendido + reservado + disponível = inicial`; pedido com vários itens é tudo ou nada; e um **teste de controle** que prova que o mesmo cenário detecta o bug numa implementação *check-then-act*.
- **Resiliência:** retry até confirmar, timeout sem nota duplicada, DLQ com liberação de estoque, erro permanente sem retries inúteis, mensagem duplicada ignorada.
- **Reconciliação:** confirma pedido já faturado no ERP e reenfileira pedido sem nota.
- **Observabilidade:** métricas expostas e `correlationId` propagado.

## Observabilidade

**Log de exemplo** (`LOG_LEVEL=debug`): a mesma `traceId` liga a requisição ao worker.

```json
{"level":"info","event":"order.accepted","correlationId":"demo-123","traceId":"046f7e70…","orderId":"32628ce1…","items":[{"sku":"CASE-IP15-BLK","quantity":2}]}
{"level":"debug","event":"span.end","span":"erp.invoice","traceId":"046f7e70…","orderId":"32628ce1…","durationMs":300.5,"attempt":1}
{"level":"info","event":"erp.invoice.succeeded","traceId":"046f7e70…","orderId":"32628ce1…","invoiceId":"NF-4830da55"}
```

**Métricas** (`/metrics`): `cache_requests_total{result=hit|miss|stale|coalesced}`, `cache_data_age_seconds`, `cache_origin_errors_total`, `checkout_requests_total{result}`, `orders_finished_total{status}`, `order_end_to_end_ms`, `queue_depth`, `dlq_depth`, `queue_retries_total`, `queue_dead_lettered_total`, `erp_calls_total{op,result}`, `erp_latency_ms`, `stock_reservations_total{result}`, `reconciliation_fixes_total{action}`, `http_requests_total`, `http_request_duration_ms`.

### Dashboard (Datadog ou equivalente)

| Linha | Widgets |
| --- | --- |
| SLOs | Disponibilidade de `/products` e `/checkout`; % de pedidos confirmados em até 5 min; orçamento de erro restante |
| Vitrine | p50/p95/p99 de `http_request_duration_ms{route=/products}`; hit ratio = `hit / (hit + miss + stale)`; `cache_data_age_seconds` p95; `cache_origin_errors_total` |
| Checkout | `checkout_requests_total` por resultado (aceito, sem estoque, inválido, replay); funil de `orders_finished_total` por status; `order_end_to_end_ms` p95 |
| Fila | `queue_depth`, `dlq_depth`, `queue_retries_total` (taxa), `worker_processing_ms` |
| ERP | `erp_latency_ms` p95 por operação; `erp_calls_total` com `result=timeout|error` |
| Estoque | `stock_reservations_total{result=insufficient}`; `reconciliation_fixes_total` |

### Alertas

```yaml
# Pedidos parados: o cliente vai reclamar antes de qualquer erro 5xx aparecer
- name: "[checkout] DLQ com mensagens"
  query: max(last_5m):max:dlq_depth{service:casecellshop-api} > 0
  severity: high
  runbook: "#runbook-pedidos-parados"

- name: "[checkout] SLO de pedidos confirmados em 5 min queimando rápido"
  type: slo_burn_rate
  windows: { short: 1h, long: 6h }
  threshold: 14.4   # consome 2% do orçamento mensal em 1 h
  severity: page

- name: "[erp] latência de faturamento degradada"
  query: avg(last_10m):p95:erp_latency_ms{op:invoice} > 2000
  severity: warning   # avisa antes de virar fila

- name: "[vitrine] hit ratio do cache caiu (risco de stampede no ERP)"
  query: sum(last_10m):cache_requests_total{result:hit}.as_count() / sum(last_10m):cache_requests_total{*}.as_count() < 0.7
  severity: warning
```

### Runbook: pedidos parados {#runbook-pedidos-parados}

1. **Medir o impacto:** `dlq_depth`, `queue_depth` e quantos pedidos estão em `PROCESSING` há mais de 5 min.
2. **Achar a causa:** `erp_latency_ms` e `erp_calls_total{result=timeout|error}` subiram? Então é o ERP. Se o ERP está normal, verificar se os workers estão consumindo (`worker_processing_ms` sem pontos novos).
3. **Mitigar:** ERP fora → acionar o time do ERP; os pedidos continuam aceitos e seguros. Worker parado → reiniciar ou escalar.
4. **Recuperar:** reprocessar a DLQ (o worker é idempotente, reprocessar é seguro) e rodar a reconciliação para os pedidos de status incerto.
5. **Comunicar** atendimento e negócio; registrar post-mortem sem culpados.

## Limitações (simplificações do desafio)

- **Estado em memória:** pedidos, estoque, chaves e outbox se perdem ao reiniciar. A atomicidade da reserva vem de o método ser síncrono num único processo Node. Com várias instâncias, ela precisa vir do banco: `UPDATE stock SET available = available - $q WHERE sku = $s AND available >= $q`, e a idempotência de uma `UNIQUE` na chave.
- **Fila em memória:** mesmas garantias de SQS/RabbitMQ (at-least-once, retry, DLQ), sem persistência.
- **ERP simulado:** latência, erro, timeout e rejeição controláveis; faturamento idempotente por `orderId`.
- **Reservas sem expiração:** liberadas apenas em falha definitiva. Em produção: expiração (por exemplo, 15 min) com job de limpeza.
- **Sem autenticação, pagamento, preço vigente no checkout nem rate limiting** (fora do escopo pedido).

## Do protótipo para produção

| Peça aqui | Em produção |
| --- | --- |
| `SwrCache` em memória | L1 em memória + Redis compartilhado; invalidação por evento de mudança de preço |
| `Inventory` em memória | Tabela `stock` no PostgreSQL da loja + reservas com expiração; sincronização e reconciliação com o ERP |
| `OrderStore` + outbox | PostgreSQL, com o outbox na mesma transação; dispatcher com `FOR UPDATE SKIP LOCKED` ou Debezium |
| `InMemoryQueue` | SQS + DLQ (redrive policy) ou RabbitMQ com dead-letter exchange |
| Logger/métricas/tracing próprios | pino, prom-client ou DogStatsD, OpenTelemetry + Datadog |
| `node:test` | Somar Testcontainers (banco real), testes de contrato contra o OpenAPI e k6 para carga |

## Uso de IA

Ver [`PROMPTS.md`](PROMPTS.md).
