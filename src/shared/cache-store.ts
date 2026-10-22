import { randomUUID } from 'node:crypto';
import type { RedisClient } from './redis';

/** Minimal key-value contract the cache needs; keeps services free of ioredis types and fakeable in tests. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Returns a token when the lock was acquired, null when someone else holds it. */
  acquireLock(key: string, ttlMs: number): Promise<string | null>;
  releaseLock(key: string, token: string): Promise<void>;
}

// Only the holder may release: a slow refresher whose lock already expired must not delete a newer holder's lock.
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function createRedisCacheStore(redis: RedisClient): CacheStore {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlMs) {
      await redis.set(key, value, 'PX', ttlMs);
    },
    async del(key) {
      await redis.del(key);
    },
    async acquireLock(key, ttlMs) {
      const token = randomUUID();
      const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
      return ok === 'OK' ? token : null;
    },
    async releaseLock(key, token) {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    },
  };
}
