import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_QUANTITY, type OutOfStockDetails } from '../../src/modules/checkout/schemas';
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
afterAll(async () => {
  await fx.cleanup();
  await db.end();
  await redis.quit();
});

const SKU_COUNT = 3;

/** One shopper: a cart over the run's SKUs (any order, so carts cross), maybe a double click, maybe a cancel. */
const commandArb = fc.record({
  cart: fc.uniqueArray(
    fc.record({ sku: fc.integer({ min: 0, max: SKU_COUNT - 1 }), quantity: fc.integer({ min: 1, max: MAX_QUANTITY }) }),
    { selector: (i) => i.sku, minLength: 1, maxLength: SKU_COUNT },
  ),
  doubleClick: fc.boolean(),
  cancel: fc.boolean(),
});

const scenarioArb = fc.record({
  stock: fc.array(fc.integer({ min: 0, max: 8 }), { minLength: SKU_COUNT, maxLength: SKU_COUNT }),
  commands: fc.array(commandArb, { minLength: 1, maxLength: 30 }),
});

type Cart = Array<{ sku: string; quantity: number }>;
type Settled<T> = PromiseSettledResult<T>;

describe('reservation properties (fast-check against the real database)', () => {
  // Every run fires all of its shoppers at once. On failure fast-check prints the seed and the shrunk scenario;
  // replay it with `fc.assert(..., { seed, path })`.
  it('no mix of concurrent orders, double clicks and cancels loses, creates or oversells stock', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ stock, commands }) => {
        try {
          const skus = await Promise.all(stock.map((available) => fx.sku({ available })));

          const runs = await Promise.all(
            commands.map(async (command) => {
              const key = uniqueId('prop');
              const cart: Cart = command.cart.map((i) => ({ sku: skus[i.sku] as string, quantity: i.quantity }));
              const place = () => services.checkout.place({ idempotencyKey: key, items: cart, correlationId: key });
              const placed: Settled<Awaited<ReturnType<typeof place>>>[] = await Promise.allSettled(
                command.doubleClick ? [place(), place()] : [place()],
              );
              const orderId = placed.find((p) => p.status === 'fulfilled')?.value.accepted.orderId;
              const cancelled =
                command.cancel && orderId ? await Promise.allSettled([services.orders.cancel(orderId)]) : [];
              return { cart, placed, orderId, cancelled };
            }),
          );

          const anyCancel = runs.some((r) => r.cancelled.length > 0);
          const live = new Map<string, Cart>();
          for (const run of runs) {
            // Same Idempotency-Key → same order, never two.
            const ids = new Set(
              run.placed.flatMap((p) => (p.status === 'fulfilled' ? [p.value.accepted.orderId] : [])),
            );
            expect(ids.size).toBeLessThanOrEqual(1);

            for (const p of run.placed) {
              if (p.status === 'fulfilled') continue;
              // The only acceptable failure is the business one: a CHECK violation or a deadlock would land here.
              expect(p.reason).toMatchObject({ code: 'OUT_OF_STOCK', httpStatus: 409 });
              const { items } = p.reason.details as OutOfStockDetails;
              for (const short of items) {
                expect(short.available).toBeGreaterThanOrEqual(0);
                // The snapshot is read after the failed UPDATE, so a cancel committing in between may return
                // units; without cancels nothing can grow stock, and what is left must be below what was asked.
                if (!anyCancel) expect(short.available).toBeLessThan(short.requested);
              }
            }

            for (const c of run.cancelled)
              expect(c).toMatchObject({ status: 'fulfilled', value: { status: 'CANCELLED' } });
            if (run.orderId && run.cancelled.length === 0) live.set(run.orderId, run.cart);
          }

          for (const [index, sku] of skus.entries()) {
            const initial = stock[index] as number;
            const { available, reserved } = await fx.inventory(sku);
            const held = [...live.values()].flatMap((cart) => cart.filter((i) => i.sku === sku));
            expect(available).toBeGreaterThanOrEqual(0);
            expect(reserved).toBeGreaterThanOrEqual(0);
            // Conservation: a unit is either on the shelf or held by exactly one live order.
            expect(available + reserved).toBe(initial);
            expect(reserved).toBe(held.reduce((sum, i) => sum + i.quantity, 0));
          }
        } finally {
          await fx.cleanup();
        }
      }),
      { numRuns: 100 },
    );
  });
});
