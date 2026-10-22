import { Redis } from 'ioredis';

export type RedisClient = Redis;

export function createRedis(url: string): RedisClient {
  // Fail fast instead of queueing commands while Redis is down: the cache layer degrades to the ERP/stale path.
  return new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
}
