import type { CacheStore } from '../../shared/cache-store';
import { isConnectionError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { type CacheResult, cacheRequests } from '../../shared/metrics';
import { withSpan } from '../../shared/tracing';

export interface CachedValue<T> {
  value: T;
  result: CacheResult;
  /** Seconds since the value was loaded from the source. */
  ageS: number;
}

export interface CachedLoader<T> {
  get(): Promise<CachedValue<T>>;
  invalidate(): Promise<void>;
}

interface Entry<T> {
  value: T;
  loadedAt: number;
  freshUntil: number;
}

interface Outcome<T> {
  result: CacheResult;
  entry: Entry<T>;
}

export interface CachedLoaderOptions<T> {
  /** Label for `cache_requests_total{cache}`. */
  name: string;
  key: string;
  store: CacheStore;
  load: () => Promise<T>;
  freshTtlS: number;
  /** How long past freshness the value may still be served if the source fails (stale-if-error). */
  staleTtlS: number;
  lockTtlMs: number;
  logger: Logger;
  /** How long a caller without a cached value waits for another instance's refresh before loading itself. */
  lockWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cache-aside with three protections for a slow, unstable source:
 * - fresh/stale windows: past `freshTtlS` we refresh, but keep the old value for `staleTtlS` as a fallback;
 * - single-flight: concurrent misses in this process share one promise, and a Redis lock makes other
 *   instances serve the previous value (or wait briefly) instead of stampeding the source;
 * - stale-if-error: when the source fails, serve the previous value and report `stale`.
 */
export function createCachedLoader<T>(opts: CachedLoaderOptions<T>): CachedLoader<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const lockKey = `${opts.key}:lock`;
  const lockWaitMs = opts.lockWaitMs ?? opts.lockTtlMs;
  let inflight: Promise<Outcome<T>> | undefined;

  const outcome = (result: CacheResult, entry: Entry<T>): Outcome<T> => ({ result, entry });

  async function readEntry(): Promise<Entry<T> | undefined> {
    let raw: string | null;
    try {
      raw = await opts.store.get(opts.key);
    } catch (err) {
      // Redis down degrades to "no cache" (the source still answers); any other failure is a bug and surfaces.
      if (!isConnectionError(err)) throw err;
      opts.logger.warn({ err, cache: opts.name }, 'cache store unavailable, bypassing cache');
      return undefined;
    }
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Entry<T>;
    } catch {
      return undefined;
    }
  }

  async function writeEntry(value: T): Promise<Entry<T>> {
    const loadedAt = now();
    const entry: Entry<T> = { value, loadedAt, freshUntil: loadedAt + opts.freshTtlS * 1000 };
    const ttlMs = (opts.freshTtlS + opts.staleTtlS) * 1000;
    await opts.store.set(opts.key, JSON.stringify(entry), ttlMs).catch((err: unknown) => {
      opts.logger.warn({ err, cache: opts.name }, 'failed to write cache entry');
    });
    return entry;
  }

  async function tryLock(): Promise<string | null | 'unavailable'> {
    try {
      return await opts.store.acquireLock(lockKey, opts.lockTtlMs);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      return 'unavailable';
    }
  }

  async function loadAndStore(previous: Entry<T> | undefined): Promise<Outcome<T>> {
    try {
      const value = await opts.load();
      return outcome('miss', await writeEntry(value));
    } catch (err) {
      if (previous) {
        opts.logger.warn({ err, cache: opts.name }, 'source failed, serving stale value');
        return outcome('stale', previous);
      }
      throw err;
    }
  }

  async function refresh(previous: Entry<T> | undefined): Promise<Outcome<T>> {
    const token = await tryLock();
    if (token === 'unavailable') return loadAndStore(previous);
    if (token === null) {
      // Another instance is refreshing. Serving the soft-expired value is refresh-ahead behaviour, not a failure.
      if (previous) return outcome('hit', previous);
      const deadline = now() + lockWaitMs;
      while (now() < deadline) {
        await sleep(50);
        const entry = await readEntry();
        if (entry) return outcome('hit', entry);
      }
      return loadAndStore(undefined);
    }
    try {
      return await loadAndStore(previous);
    } finally {
      await opts.store.releaseLock(lockKey, token).catch(() => undefined);
    }
  }

  return {
    get() {
      return withSpan('cache.get', { 'cache.name': opts.name }, async (span) => {
        const entry = await readEntry();
        let out: Outcome<T>;
        if (entry && now() < entry.freshUntil) {
          out = outcome('hit', entry);
        } else {
          inflight ??= refresh(entry).finally(() => {
            inflight = undefined;
          });
          out = await inflight;
        }
        // Counted per caller, not per refresh: 50 requests sharing one load are 50 cache lookups.
        cacheRequests.inc({ cache: opts.name, result: out.result });
        span.setAttribute('cache.result', out.result);
        return {
          value: out.entry.value,
          result: out.result,
          ageS: Math.max(0, Math.round((now() - out.entry.loadedAt) / 1000)),
        };
      });
    },
    async invalidate() {
      await opts.store.del(opts.key);
    },
  };
}
