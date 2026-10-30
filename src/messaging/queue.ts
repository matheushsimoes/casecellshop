import { randomUUID } from 'node:crypto';
import type { Metrics } from '../observability/metrics.ts';

export type QueueMessage = {
  id: string;
  orderId: string;
  correlationId: string;
  traceparent: string;
  attempt: number;
  enqueuedAt: number;
};

/** Erro transitório: a mensagem volta para a fila com backoff. */
export class RetryableError extends Error {}
/** Erro permanente: tentar de novo não muda nada, vai direto para a DLQ. */
export class PermanentError extends Error {}

export type DeadLetter = { message: QueueMessage; reason: string; deadAt: number };

export type QueueOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  concurrency: number;
  metrics: Metrics;
};

type Handler = (msg: QueueMessage) => Promise<void>;
type DeadLetterHook = (dead: DeadLetter) => void;

/**
 * Fila em memória com semântica de SQS/RabbitMQ:
 * - entrega at-least-once (o consumidor precisa ser idempotente);
 * - retry com backoff exponencial + jitter;
 * - DLQ depois de `maxAttempts` ou em erro permanente.
 * Em produção: SQS + DLQ (redrive policy) ou RabbitMQ com dead-letter exchange.
 */
export class InMemoryQueue {
  readonly dlq: DeadLetter[] = [];
  private readonly ready: QueueMessage[] = [];
  private readonly opts: QueueOptions;
  private handler?: Handler;
  private onDeadLetter?: DeadLetterHook;
  private active = 0;
  private scheduled = 0;
  private waiters: Array<() => void> = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(opts: QueueOptions) {
    this.opts = opts;
  }

  subscribe(handler: Handler, onDeadLetter: DeadLetterHook): void {
    this.handler = handler;
    this.onDeadLetter = onDeadLetter;
    this.pump();
  }

  publish(input: Omit<QueueMessage, 'id' | 'attempt' | 'enqueuedAt'>): void {
    this.ready.push({ ...input, id: randomUUID(), attempt: 1, enqueuedAt: Date.now() });
    this.opts.metrics.queuePublished.inc();
    this.updateGauges();
    this.pump();
  }

  depth(): number {
    return this.ready.length + this.scheduled + this.active;
  }

  /** Resolve quando não há nada pronto, agendado ou em processamento (usado nos testes). */
  idle(): Promise<void> {
    if (this.depth() === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private pump(): void {
    while (this.handler && this.active < this.opts.concurrency && this.ready.length > 0) {
      const msg = this.ready.shift()!;
      this.active++;
      void this.process(msg);
    }
    this.updateGauges();
    this.notifyIfIdle();
  }

  private async process(msg: QueueMessage): Promise<void> {
    try {
      await this.handler!(msg);
    } catch (err) {
      const reason = (err as Error).message;
      if (err instanceof PermanentError || msg.attempt >= this.opts.maxAttempts) {
        this.deadLetter(msg, reason);
      } else {
        this.retryLater(msg);
      }
    } finally {
      this.active--;
      this.pump();
    }
  }

  private retryLater(msg: QueueMessage): void {
    const cap = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (msg.attempt - 1));
    const delay = Math.round(Math.random() * cap);
    this.scheduled++;
    this.opts.metrics.queueRetries.inc();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.scheduled--;
      this.ready.push({ ...msg, attempt: msg.attempt + 1 });
      this.pump();
    }, delay);
    this.timers.add(timer);
  }

  private deadLetter(msg: QueueMessage, reason: string): void {
    const dead = { message: msg, reason, deadAt: Date.now() };
    this.dlq.push(dead);
    this.opts.metrics.queueDlq.inc();
    this.onDeadLetter?.(dead);
  }

  private updateGauges(): void {
    this.opts.metrics.queueDepth.set(this.depth());
    this.opts.metrics.dlqDepth.set(this.dlq.length);
  }

  private notifyIfIdle(): void {
    if (this.depth() !== 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }
}
