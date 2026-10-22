import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { createServices, createTestRedis, type TestServices } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';

let db: Db;
let redis: RedisClient;
let services: TestServices;
let fx: Fixtures;

beforeAll(() => {
  db = createTestDb();
  redis = createTestRedis();
  services = createServices(db, redis, new FakeErp());
  fx = new Fixtures(db);
});
afterEach(() => fx.cleanup());
afterAll(async () => {
  await db.end();
  await redis.quit();
});

function place(items: Array<{ sku: string; quantity: number }>, key = uniqueId('k')) {
  return services.checkout.place({ idempotencyKey: key, items, correlationId: key });
}

describe('checkout under concurrency (no overselling)', () => {
  it('40 parallel buyers on a SKU with 5 units: exactly 5 accepted, 35 out of stock', async () => {
    const sku = await fx.sku({ available: 5 });

    const results = await Promise.allSettled(Array.from({ length: 40 }, () => place([{ sku, quantity: 1 }])));

    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(35);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: 'OUT_OF_STOCK', httpStatus: 409 });
    expect(await fx.inventory(sku)).toEqual({ available: 0, reserved: 5 });
  });

  it('accepts exactly min(N, S) with multi-unit orders and never goes negative', async () => {
    const sku = await fx.sku({ available: 7 });

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => place([{ sku, quantity: 2 }])));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(await fx.inventory(sku)).toEqual({ available: 1, reserved: 6 });
  });

  it('reserves all items of an order or none (no partial reservation)', async () => {
    const plenty = await fx.sku({ available: 10 });
    const scarce = await fx.sku({ available: 0 });

    await expect(
      place([
        { sku: plenty, quantity: 2 },
        { sku: scarce, quantity: 1 },
      ]),
    ).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
      details: { skus: [scarce], items: [{ sku: scarce, requested: 1, available: 0 }] },
    });

    expect(await fx.inventory(plenty)).toEqual({ available: 10, reserved: 0 });
  });

  it('crossed carts (A+B and B+A at the same time) finish without deadlock', async () => {
    const a = await fx.sku({ available: 20 });
    const b = await fx.sku({ available: 20 });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        place(
          i % 2 === 0
            ? [
                { sku: a, quantity: 1 },
                { sku: b, quantity: 1 },
              ]
            : [
                { sku: b, quantity: 1 },
                { sku: a, quantity: 1 },
              ],
        ),
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await fx.inventory(a)).toEqual({ available: 0, reserved: 20 });
    expect(await fx.inventory(b)).toEqual({ available: 0, reserved: 20 });
  });
});
