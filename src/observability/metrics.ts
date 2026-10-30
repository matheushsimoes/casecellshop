type Labels = Record<string, string>;

const keyOf = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`)
    .join(',');

export class Counter {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = keyOf(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels)) ?? 0;
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`)];
  }
}

export class Gauge {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  set(value: number, labels: Labels = {}): void {
    this.values.set(keyOf(labels), value);
  }
  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels)) ?? 0;
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, ...[...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`)];
  }
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}): void {
    const k = keyOf(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i] = (s.counts[i] ?? 0) + 1;
    });
    s.sum += value;
    s.count += 1;
  }
  count(labels: Labels = {}): number {
    return this.series.get(keyOf(labels))?.count ?? 0;
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines;
  }
}

const ms = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

export function createMetrics() {
  return {
    httpRequests: new Counter('http_requests_total', 'Requisições HTTP por rota e status'),
    httpLatency: new Histogram('http_request_duration_ms', 'Latência HTTP por rota', ms),
    cacheRequests: new Counter('cache_requests_total', 'Consultas ao cache por resultado (hit, miss, stale, coalesced)'),
    cacheOriginErrors: new Counter('cache_origin_errors_total', 'Falhas ao buscar a origem do cache'),
    cacheDataAge: new Histogram('cache_data_age_seconds', 'Idade do dado servido pelo cache', [1, 5, 15, 30, 60, 120, 300]),
    checkoutRequests: new Counter('checkout_requests_total', 'Checkouts por resultado'),
    ordersFinished: new Counter('orders_finished_total', 'Pedidos finalizados por status'),
    orderEndToEnd: new Histogram('order_end_to_end_ms', 'Tempo do aceite ao status final', [100, 500, 1000, 5000, 30000, 60000, 300000]),
    queuePublished: new Counter('queue_published_total', 'Mensagens publicadas'),
    queueRetries: new Counter('queue_retries_total', 'Mensagens reagendadas para nova tentativa'),
    queueDlq: new Counter('queue_dead_lettered_total', 'Mensagens enviadas para a DLQ'),
    queueDepth: new Gauge('queue_depth', 'Mensagens aguardando processamento'),
    dlqDepth: new Gauge('dlq_depth', 'Mensagens na DLQ'),
    workerProcessing: new Histogram('worker_processing_ms', 'Duração de cada tentativa de processamento', ms),
    erpCalls: new Counter('erp_calls_total', 'Chamadas ao ERP por operação e resultado'),
    erpLatency: new Histogram('erp_latency_ms', 'Latência das chamadas ao ERP', ms),
    stockReservations: new Counter('stock_reservations_total', 'Tentativas de reserva por resultado'),
    reconciliationFixes: new Counter('reconciliation_fixes_total', 'Pedidos corrigidos pela reconciliação'),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function renderMetrics(metrics: Metrics): string {
  return Object.values(metrics).flatMap((m) => m.render()).join('\n') + '\n';
}
