import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInvoicingRepository } from '../../src/modules/invoicing/repository';
import { createInvoicingService, type InvoicingService } from '../../src/modules/invoicing/service';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { createServices, createTestRedis, type TestServices } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';
import { silentLogger } from '../support/fakes';

let db: Db;
let redis: RedisClient;
let fx: Fixtures;

beforeAll(() => {
  db = createTestDb();
  redis = createTestRedis();
  fx = new Fixtures(db);
});
afterEach(() => fx.cleanup());
afterAll(async () => {
  await db.end();
  await redis.quit();
});

function setup(erp = new FakeErp()): { services: TestServices; invoicing: InvoicingService; erp: FakeErp } {
  const services = createServices(db, redis, erp);
  const invoicing = createInvoicingService({
    repo: createInvoicingRepository(db),
    erp,
    logger: silentLogger,
    backoff: { baseS: 1, maxS: 4, maxAttempts: 5 },
    stuckInvoicingAfterS: 120,
    leaseS: 15,
  });
  return { services, invoicing, erp };
}

async function placeOrder(services: TestServices, items: Array<{ sku: string; quantity: number }>) {
  const key = uniqueId('cancel');
  const { accepted } = await services.checkout.place({ idempotencyKey: key, items, correlationId: key });
  return accepted.orderId;
}

describe('customer cancellation against the real database', () => {
  it('cancels a reserved order and gives every reserved unit back in the same transaction', async () => {
    const { services } = setup();
    const a = await fx.sku({ available: 5 });
    const b = await fx.sku({ available: 3 });
    const orderId = await placeOrder(services, [
      { sku: a, quantity: 2 },
      { sku: b, quantity: 3 },
    ]);
    expect(await fx.inventory(b)).toEqual({ available: 0, reserved: 3 });

    const order = await services.orders.cancel(orderId);

    expect(order.status).toBe('CANCELLED');
    expect(order.history.map((h) => [h.from, h.to])).toEqual([
      [null, 'RESERVED'],
      ['RESERVED', 'CANCELLED'],
    ]);
    expect(order.history[1]?.detail).toEqual({ reason: 'cancelled by customer', released: true });
    expect(await fx.inventory(a)).toEqual({ available: 5, reserved: 0 });
    expect(await fx.inventory(b)).toEqual({ available: 3, reserved: 0 });
  });

  it('is idempotent: a second cancel answers the same and releases nothing twice', async () => {
    const { services } = setup();
    const sku = await fx.sku({ available: 4 });
    const orderId = await placeOrder(services, [{ sku, quantity: 2 }]);

    const first = await services.orders.cancel(orderId);
    const second = await services.orders.cancel(orderId);

    expect(second).toEqual(first);
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 0 });
    expect(await fx.count('order_events', orderId)).toBe(2);
  });

  it('10 concurrent cancels of one order release its stock exactly once', async () => {
    const { services } = setup();
    const sku = await fx.sku({ available: 6 });
    const orderId = await placeOrder(services, [{ sku, quantity: 3 }]);
    // Another live reservation on the same SKU: a double release would wrongly free its units too.
    await placeOrder(services, [{ sku, quantity: 2 }]);

    const results = await Promise.all(Array.from({ length: 10 }, () => services.orders.cancel(orderId)));

    expect(results.every((r) => r.status === 'CANCELLED')).toBe(true);
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 2 });
    expect(await fx.count('order_events', orderId)).toBe(2);
  });

  it('cancel racing the worker: either invoiced with stock sold, or cancelled with no ERP invoice — never both', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { services, invoicing, erp } = setup();
      const sku = await fx.sku({ available: 2 });
      const orderId = await placeOrder(services, [{ sku, quantity: 2 }]);

      const [cancel] = await Promise.allSettled([services.orders.cancel(orderId), invoicing.processOrder(orderId)]);
      const final = await fx.order(orderId);

      if (final?.status === 'CANCELLED') {
        expect(cancel.status).toBe('fulfilled');
        expect(erp.calls.createInvoice).toBe(0);
        expect(await fx.inventory(sku)).toEqual({ available: 2, reserved: 0 });
      } else {
        expect(final?.status).toBe('INVOICED');
        expect(cancel).toMatchObject({ status: 'rejected', reason: { code: 'ORDER_NOT_CANCELLABLE' } });
        expect(erp.invoices).toHaveLength(1);
        expect(await fx.inventory(sku)).toEqual({ available: 0, reserved: 0 });
      }
      await fx.cleanup();
    }
  });

  it('refuses an invoiced order with 409 and leaves the sale untouched', async () => {
    const { services, invoicing } = setup();
    const sku = await fx.sku({ available: 5 });
    const orderId = await placeOrder(services, [{ sku, quantity: 1 }]);
    await invoicing.processOrder(orderId);

    await expect(services.orders.cancel(orderId)).rejects.toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
      httpStatus: 409,
      details: { status: 'INVOICED' },
    });
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 0 });
  });

  it('a late SQS delivery after the cancel is acked without calling the ERP', async () => {
    const { services, invoicing, erp } = setup();
    const sku = await fx.sku({ available: 5 });
    const orderId = await placeOrder(services, [{ sku, quantity: 1 }]);
    await services.orders.cancel(orderId);

    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack' });
    expect(erp.calls).toMatchObject({ createInvoice: 0, findInvoices: 0 });
    expect((await fx.order(orderId))?.status).toBe('CANCELLED');
  });

  it('returns 404 for an unknown order', async () => {
    const { services } = setup();
    await expect(services.orders.cancel('2f1e0d9c-8b7a-4695-8473-625140302f1e')).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      httpStatus: 404,
    });
  });
});
