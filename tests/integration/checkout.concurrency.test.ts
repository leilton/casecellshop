import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutRepository } from '../../src/modules/checkout/repository';
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

describe('checkout repository edges', () => {
  const input = (items: Array<{ sku: string; quantity: number; priceCents: number }>, totalCents = 1000) => {
    const key = uniqueId('repo');
    return {
      idempotencyKey: key,
      requestHash: key,
      items,
      totalCents,
      correlationId: key,
      reservationTtlS: 900,
      message: { correlationId: key },
    };
  };

  it('records the reserved items (sku and quantity only) on the RESERVED event', async () => {
    const sku = await fx.sku({ available: 5 });

    const result = await createCheckoutRepository(db).placeOrder(input([{ sku, quantity: 2, priceCents: 1000 }]));

    expect(result.kind).toBe('created');
    const orderId = result.kind === 'created' ? result.orderId : '';
    const history = (await services.orders.getStatus(orderId)).history;
    expect(history[0]?.detail).toEqual({ items: [{ sku, quantity: 2 }] });
  });

  it('a product without an inventory row is reported as 0 left, not as an error', async () => {
    const sku = uniqueId('NOINV');
    fx.track(sku);
    await db.query('INSERT INTO products (sku, name, price_cents) VALUES ($1, $1, 1000)', [sku]);

    const result = await createCheckoutRepository(db).placeOrder(input([{ sku, quantity: 1, priceCents: 1000 }]));

    expect(result).toEqual({ kind: 'out_of_stock', items: [{ sku, requested: 1, available: 0 }] });
  });

  it('a database error is propagated, never mistaken for out of stock', async () => {
    const sku = await fx.sku({ available: 5 });

    await expect(
      createCheckoutRepository(db).placeOrder(input([{ sku, quantity: 1, priceCents: 1000 }], 2 ** 40)),
    ).rejects.toThrow(/out of range/);
    expect(await fx.inventory(sku)).toEqual({ available: 5, reserved: 0 });
  });
});
