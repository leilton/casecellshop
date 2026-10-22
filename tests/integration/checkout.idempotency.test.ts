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

const place = (key: string, items: Array<{ sku: string; quantity: number }>) =>
  services.checkout.place({ idempotencyKey: key, items, correlationId: key });

describe('checkout idempotency', () => {
  it('a simultaneous double click returns one order with one reservation, one event and one outbox row', async () => {
    const sku = await fx.sku({ available: 5 });
    const key = uniqueId('dbl');

    const [a, b] = await Promise.all([place(key, [{ sku, quantity: 1 }]), place(key, [{ sku, quantity: 1 }])]);

    expect(a.accepted.orderId).toBe(b.accepted.orderId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 1 });
    expect(await fx.count('order_events', a.accepted.orderId)).toBe(1);
    expect(await fx.count('outbox', a.accepted.orderId)).toBe(1);
  });

  it('ten retries with the same key all get the same orderId', async () => {
    const sku = await fx.sku({ available: 5 });
    const key = uniqueId('retry');

    const results = await Promise.all(Array.from({ length: 10 }, () => place(key, [{ sku, quantity: 2 }])));

    expect(new Set(results.map((r) => r.accepted.orderId)).size).toBe(1);
    expect(await fx.inventory(sku)).toEqual({ available: 3, reserved: 2 });
  });

  it('treats the same items in a different order as the same request', async () => {
    const a = await fx.sku({ available: 5 });
    const b = await fx.sku({ available: 5 });
    const key = uniqueId('order');

    const first = await place(key, [
      { sku: a, quantity: 1 },
      { sku: b, quantity: 2 },
    ]);
    const second = await place(key, [
      { sku: b, quantity: 2 },
      { sku: a, quantity: 1 },
    ]);

    expect(second).toEqual({ duplicate: true, accepted: first.accepted });
  });

  it('rejects the same key with a different payload (422) and reserves nothing more', async () => {
    const sku = await fx.sku({ available: 5 });
    const key = uniqueId('reuse');
    await place(key, [{ sku, quantity: 1 }]);

    await expect(place(key, [{ sku, quantity: 2 }])).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      httpStatus: 422,
    });
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 1 });
  });

  it('a key that got 409 can be retried and re-evaluates stock (nothing was stored for it)', async () => {
    const sku = await fx.sku({ available: 0 });
    const key = uniqueId('oos');
    await expect(place(key, [{ sku, quantity: 1 }])).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });

    await db.query('UPDATE inventory SET available = 1 WHERE sku = $1', [sku]);

    const retry = await place(key, [{ sku, quantity: 1 }]);
    expect(retry.duplicate).toBe(false);
    expect(await fx.inventory(sku)).toEqual({ available: 0, reserved: 1 });
  });

  it('stores server-side prices and the total in cents', async () => {
    const sku = await fx.sku({ available: 5, priceCents: 4990 });

    const { accepted } = await place(uniqueId('price'), [{ sku, quantity: 3 }]);
    const status = await services.orders.getStatus(accepted.orderId);

    expect(status).toMatchObject({
      status: 'RESERVED',
      totalCents: 14970,
      items: [{ sku, quantity: 3, priceCents: 4990 }],
      history: [{ from: null, to: 'RESERVED' }],
    });
  });
});
