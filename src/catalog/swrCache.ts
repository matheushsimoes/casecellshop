import type { Metrics } from '../observability/metrics.ts';
import { logger } from '../observability/logger.ts';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';
export type CacheResult<T> = { value: T; status: CacheStatus; ageSeconds: number };

type Entry<T> = { value: T; fetchedAt: number; expiresAt: number; staleUntil: number };

export type SwrCacheOptions = {
  name: string;
  /** Tempo em que o valor é considerado fresco. */
  ttlMs: number;
  /** Janela extra em que o valor velho ainda pode ser servido (revalidação ou falha da origem). */
  staleMs: number;
  /** Variação aleatória do TTL (0.1 = ±10%) para chaves não expirarem juntas. */
  jitterRatio?: number;
  now?: () => number;
  metrics: Metrics;
};

/**
 * Cache em memória com:
 * - cache-aside com TTL e jitter;
 * - single-flight: chamadas simultâneas para a mesma chave compartilham UMA busca na origem
 *   (proteção contra cache stampede);
 * - stale-while-revalidate: depois do TTL, serve o valor velho e renova em background;
 * - stale-if-error: se a origem falhar, o valor velho continua sendo servido dentro da janela.
 *
 * Em produção, a camada compartilhada seria o Redis, com o lock do single-flight via
 * `SET key NX PX`. Este cache em memória faria o papel de L1 por instância.
 */
export class SwrCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<Entry<T>>>();
  private readonly opts: SwrCacheOptions;
  private readonly now: () => number;

  constructor(opts: SwrCacheOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async get(key: string, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const now = this.now();
    const entry = this.entries.get(key);

    if (entry && now < entry.expiresAt) return this.serve(entry, 'HIT');

    if (entry && now < entry.staleUntil) {
    
      this.refresh(key, loader).catch(() => undefined);
      return this.serve(entry, 'STALE');
    }

    const coalesced = this.inflight.has(key);
    const fresh = await this.refresh(key, loader);
    this.opts.metrics.cacheRequests.inc({ cache: this.opts.name, result: coalesced ? 'coalesced' : 'miss' });
    return { value: fresh.value, status: 'MISS', ageSeconds: 0 };
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  private serve(entry: Entry<T>, status: 'HIT' | 'STALE'): CacheResult<T> {
    const ageSeconds = (this.now() - entry.fetchedAt) / 1000;
    this.opts.metrics.cacheRequests.inc({ cache: this.opts.name, result: status.toLowerCase() });
    this.opts.metrics.cacheDataAge.observe(ageSeconds, { cache: this.opts.name });
    return { value: entry.value, status, ageSeconds };
  }

  private refresh(key: string, loader: () => Promise<T>): Promise<Entry<T>> {
    const running = this.inflight.get(key);
    if (running) return running;

    const promise = (async () => {
      try {
        const value = await loader();
        const fetchedAt = this.now();
        const jitter = 1 + (Math.random() * 2 - 1) * (this.opts.jitterRatio ?? 0);
        const expiresAt = fetchedAt + this.opts.ttlMs * jitter;
        const entry: Entry<T> = { value, fetchedAt, expiresAt, staleUntil: expiresAt + this.opts.staleMs };
        this.entries.set(key, entry);
        return entry;
      } catch (err) {
        this.opts.metrics.cacheOriginErrors.inc({ cache: this.opts.name });
        logger.warn('cache.origin_error', { cache: this.opts.name, key, error: (err as Error).message });
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
