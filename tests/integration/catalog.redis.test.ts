import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCachedLoader } from '../../src/modules/catalog/cache';
import { createCatalogRepository } from '../../src/modules/catalog/repository';
import { createCatalogService } from '../../src/modules/catalog/service';
import { createCatalogSync } from '../../src/modules/catalog/sync';
import { createRedisCacheStore } from '../../src/shared/cache-store';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { readyRedis } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';
import { silentLogger } from '../support/fakes';

let db: Db;
let redis: RedisClient;
let fx: Fixtures;

beforeAll(async () => {
  db = createTestDb();
  redis = await readyRedis();
  fx = new Fixtures(db);
});
afterEach(() => fx.cleanup());
afterAll(async () => {
  await db.end();
  await redis.quit();
});

describe('Redis cache store', () => {
  it('only the lock holder can release the lock', async () => {
    const store = createRedisCacheStore(redis);
    const key = uniqueId('lock');

    const token = await store.acquireLock(key, 5000);
    expect(token).toEqual(expect.any(String));
    expect(await store.acquireLock(key, 5000)).toBeNull();

    await store.releaseLock(key, 'someone-else');
    expect(await redis.get(key)).toBe(token);
    await store.releaseLock(key, token ?? '');
    expect(await redis.get(key)).toBeNull();
  });

  it('stores entries with a TTL covering the fresh plus stale windows', async () => {
    const store = createRedisCacheStore(redis);
    const key = uniqueId('entry');
    const loader = createCachedLoader({
      name: 'ttl-test',
      key,
      store,
      load: async () => 'v',
      freshTtlS: 5,
      staleTtlS: 10,
      lockTtlMs: 1000,
      logger: silentLogger,
    });

    await loader.get();
    const ttl = await redis.pttl(key);

    expect(ttl).toBeGreaterThan(14_000);
    expect(ttl).toBeLessThanOrEqual(15_000);
    await redis.del(key);
  });

  it('two app instances sharing Redis make a single ERP call for concurrent misses', async () => {
    const sku = await fx.sku({ available: 3 });
    const erp = new FakeErp([{ sku }]);
    erp.delayMs = 100;
    // Two instances share the cache keys (same prefix) but each has its own in-process single-flight,
    // so only the Redis lock can stop them from both calling the ERP.
    const prefix = uniqueId('shared');
    const make = () =>
      createCatalogService({
        erp,
        repo: createCatalogRepository(db),
        store: createRedisCacheStore(redis),
        logger: silentLogger,
        ttl: { priceS: 60, stockS: 5, staleIfErrorS: 120, lockMs: 2000 },
        keyPrefix: `${prefix}:`,
      });
    const [one, two] = [make(), make()];

    await Promise.all([
      ...Array.from({ length: 10 }, () => one.list()),
      ...Array.from({ length: 10 }, () => two.list()),
    ]);

    expect(erp.calls.listProducts).toBe(1);
    await redis.del(`${prefix}:catalog:v1:products`, `${prefix}:catalog:v1:stock`);
  });
});

describe('catalog sync against the read model', () => {
  it('upserts a changed price, keeps the higher version and creates inventory for new SKUs', async () => {
    const existing = await fx.sku({ available: 4, priceCents: 1000 });
    const fresh = uniqueId('NEW');
    fx.track(fresh);
    const erp = new FakeErp([
      { sku: existing, priceCents: 1000 },
      { sku: fresh, priceCents: 777 },
    ]);
    erp.setProduct(existing, { priceCents: 1500 });
    const repo = createCatalogRepository(db);
    let evicted = 0;
    const sync = createCatalogSync({
      erp,
      repo,
      catalog: {
        invalidateProducts: async () => {
          evicted += 1;
        },
      },
      logger: silentLogger,
    });

    const changed = await sync.runOnce();

    expect(changed).toEqual(expect.arrayContaining([existing, fresh]));
    expect(evicted).toBe(1);
    expect(await repo.findPriced([existing, fresh])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sku: existing, priceCents: 1500 }),
        expect.objectContaining({ sku: fresh, priceCents: 777 }),
      ]),
    );
    expect(await fx.inventory(existing)).toEqual({ available: 4, reserved: 0 });
    expect(await fx.inventory(fresh)).toEqual({ available: 0, reserved: 0 });
    // Running again with nothing new is a no-op.
    expect(await sync.runOnce()).not.toContain(existing);
  });

  it('never moves a product back to an older version', async () => {
    const sku = await fx.sku({ available: 1, priceCents: 2000, version: 5 });
    const repo = createCatalogRepository(db);

    await repo.upsertProducts([{ sku, name: 'old', priceCents: 1, version: 3 }]);

    expect(await repo.findPriced([sku])).toEqual([{ sku, name: `Test ${sku}`, priceCents: 2000 }]);
  });
});
