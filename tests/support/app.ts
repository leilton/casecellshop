import { type AppDeps, buildApp } from '../../src/api/app';
import { createCatalogRepository } from '../../src/modules/catalog/repository';
import { type CatalogService, createCatalogService } from '../../src/modules/catalog/service';
import { createCheckoutRepository } from '../../src/modules/checkout/repository';
import { type CheckoutService, createCheckoutService } from '../../src/modules/checkout/service';
import { createOrdersRepository } from '../../src/modules/orders/repository';
import { createOrdersService, type OrdersService } from '../../src/modules/orders/service';
import { createRedisCacheStore } from '../../src/shared/cache-store';
import type { Db } from '../../src/shared/db';
import { createRedis, type RedisClient } from '../../src/shared/redis';
import { requireEnv, uniqueId } from './env';
import type { FakeErp } from './fake-erp';
import { silentLogger } from './fakes';

export interface TestServices {
  catalog: CatalogService;
  checkout: CheckoutService;
  orders: OrdersService;
}

export function createServices(db: Db, redis: RedisClient, erp: FakeErp, reservationTtlS = 900): TestServices {
  const catalog = createCatalogService({
    erp,
    repo: createCatalogRepository(db),
    store: createRedisCacheStore(redis),
    logger: silentLogger,
    ttl: { priceS: 60, stockS: 5, staleIfErrorS: 120, lockMs: 1000 },
    keyPrefix: `${uniqueId('test')}:`,
  });
  const checkout = createCheckoutService({
    repo: createCheckoutRepository(db),
    catalog,
    logger: silentLogger,
    reservationTtlS,
  });
  const orders = createOrdersService({ repo: createOrdersRepository(db) });
  return { catalog, checkout, orders };
}

export function createTestRedis(): RedisClient {
  return createRedis(requireEnv('REDIS_URL'));
}

/** The client fails fast while connecting (no offline queue), so tests that hit Redis directly wait for it. */
export async function readyRedis(): Promise<RedisClient> {
  const redis = createTestRedis();
  if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
  return redis;
}

/** The real Fastify app wired to real Postgres/Redis and a fake ERP; any service can be swapped for a stub. */
export async function createTestApp(
  db: Db,
  redis: RedisClient,
  erp: FakeErp,
  overrides: Partial<Omit<AppDeps, 'logger'>> = {},
) {
  const services = createServices(db, redis, erp);
  const app = await buildApp({
    logger: silentLogger,
    ...services,
    health: async () => ({ postgres: 'ok', redis: 'ok', sqs: 'ok', erp: 'ok' }),
    ...overrides,
  });
  await app.ready();
  return { app, services };
}
