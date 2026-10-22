import type { CacheStore } from '../../src/shared/cache-store';
import { createLogger, type Logger } from '../../src/shared/logger';

export const silentLogger: Logger = createLogger('test', 'silent');

/** Map-backed CacheStore honouring TTLs against an injectable clock. */
export class MemoryCacheStore implements CacheStore {
  readonly data = new Map<string, { value: string; expiresAt: number }>();
  failWith: unknown;
  now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(key: string) {
    this.throwIfFailing();
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number) {
    this.throwIfFailing();
    this.data.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async del(key: string) {
    this.throwIfFailing();
    this.data.delete(key);
  }

  async acquireLock(key: string, ttlMs: number) {
    this.throwIfFailing();
    if ((await this.get(key)) !== null) return null;
    const token = `token-${Math.random()}`;
    await this.set(key, token, ttlMs);
    return token;
  }

  async releaseLock(key: string, token: string) {
    if ((await this.get(key)) === token) this.data.delete(key);
  }

  private throwIfFailing() {
    if (this.failWith) throw this.failWith;
  }
}

/** Mutable clock for TTL tests. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

/** An error shaped like a refused TCP connection (what pg/ioredis raise when the server is down). */
export function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' });
}
