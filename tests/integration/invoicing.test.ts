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

function setup(
  erp = new FakeErp(),
  reservationTtlS = 900,
): { services: TestServices; invoicing: InvoicingService; erp: FakeErp } {
  const services = createServices(db, redis, erp, reservationTtlS);
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

async function placeOrder(services: TestServices, sku: string, quantity = 2) {
  const key = uniqueId('inv');
  const { accepted } = await services.checkout.place({
    idempotencyKey: key,
    items: [{ sku, quantity }],
    correlationId: key,
  });
  return accepted.orderId;
}

describe('invoicing against the real database', () => {
  it('turns the reservation into a sale when the invoice is created', async () => {
    const { services, invoicing, erp } = setup();
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);

    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack' });

    expect(await fx.order(orderId)).toMatchObject({
      status: 'INVOICED',
      attempts: 1,
      erp_invoice_id: erp.invoices[0]?.invoiceId,
    });
    expect(await fx.inventory(sku)).toEqual({ available: 8, reserved: 0 });
    const history = (await services.orders.getStatus(orderId)).history.map((h) => h.to);
    expect(history).toEqual(['RESERVED', 'INVOICING', 'INVOICED']);
  });

  it('retry after a timeout that DID create the invoice: lookup adopts it, never a second invoice', async () => {
    const { services, invoicing, erp } = setup(new FakeErp().failNext('createInvoice', 'timeout-after-create'));
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);

    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'retry' });
    expect(await fx.order(orderId)).toMatchObject({ status: 'INVOICING', attempts: 1 });
    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack' });
    // A redelivered duplicate of the same message afterwards is a no-op.
    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack', reason: 'order already INVOICED' });

    expect(erp.invoicesFor(orderId)).toHaveLength(1);
    expect(await fx.order(orderId)).toMatchObject({ status: 'INVOICED', attempts: 2, last_error: null });
    expect(await fx.inventory(sku)).toEqual({ available: 8, reserved: 0 });
  });

  it('two workers processing the same message concurrently produce exactly one invoice (lease)', async () => {
    const erp = new FakeErp();
    erp.delayMs = 100;
    const { services, invoicing } = setup(erp);
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);

    const results = await Promise.all([invoicing.processOrder(orderId), invoicing.processOrder(orderId)]);

    expect(results.map((r) => r.action).sort()).toEqual(['ack', 'retry']);
    expect(results.find((r) => r.action === 'retry')).toMatchObject({ reason: 'another attempt is in flight' });
    expect(erp.invoicesFor(orderId)).toHaveLength(1);
    expect(await fx.order(orderId)).toMatchObject({ status: 'INVOICED', attempts: 1 });
    expect(await fx.inventory(sku)).toEqual({ available: 8, reserved: 0 });
  });

  it('an expired lease (worker died mid-call) lets the next delivery proceed with a lookup first', async () => {
    const erp = new FakeErp();
    const { services, invoicing } = setup(erp);
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);
    // Simulate a worker that took the lease, created the invoice and crashed before recording it.
    await db.query(
      `UPDATE orders SET status = 'INVOICING', attempts = 1, invoicing_lease_until = now() - interval '1 second'
       WHERE id = $1`,
      [orderId],
    );
    erp.invoices.push({ invoiceId: 'inv-crashed', orderId, createdAt: new Date().toISOString() });

    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack', reason: 'invoiced via lookup' });
    expect(erp.invoicesFor(orderId)).toHaveLength(1);
    expect(await fx.order(orderId)).toMatchObject({ status: 'INVOICED', erp_invoice_id: 'inv-crashed' });
  });

  it('a dead-lettered order without an invoice fails and gives the stock back', async () => {
    const { services, invoicing } = setup(new FakeErp().failAlways('createInvoice', 'unavailable'));
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku, 3);
    for (let i = 0; i < 5; i++) await invoicing.processOrder(orderId);

    expect(await invoicing.handleDeadLetter(orderId)).toMatchObject({ action: 'ack' });

    expect(await fx.order(orderId)).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(await fx.inventory(sku)).toEqual({ available: 10, reserved: 0 });
    // Handling the same dead letter twice must not release the stock twice.
    await invoicing.handleDeadLetter(orderId);
    expect(await fx.inventory(sku)).toEqual({ available: 10, reserved: 0 });
  });

  it('a dead-lettered order that the ERP did invoice is settled as INVOICED, not FAILED', async () => {
    const erp = new FakeErp().failNext('createInvoice', 'timeout-after-create');
    const { services, invoicing } = setup(erp);
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);
    await invoicing.processOrder(orderId);

    await invoicing.handleDeadLetter(orderId);

    expect((await fx.order(orderId))?.status).toBe('INVOICED');
    expect(await fx.inventory(sku)).toEqual({ available: 8, reserved: 0 });
    expect(erp.invoicesFor(orderId)).toHaveLength(1);
  });

  it('an ERP 4xx fails the order immediately and releases the stock', async () => {
    const { services, invoicing } = setup(new FakeErp().failNext('createInvoice', 'client'));
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);

    expect(await invoicing.processOrder(orderId)).toMatchObject({ action: 'ack' });

    expect((await fx.order(orderId))?.status).toBe('FAILED');
    expect(await fx.inventory(sku)).toEqual({ available: 10, reserved: 0 });
  });

  it('reconciliation cancels expired reservations and leaves fresh ones alone', async () => {
    const expiredSetup = setup(new FakeErp(), 1);
    const freshSetup = setup(new FakeErp(), 900);
    const sku = await fx.sku({ available: 10 });
    const expired = await placeOrder(expiredSetup.services, sku, 1);
    const fresh = await placeOrder(freshSetup.services, sku, 1);
    await db.query(`UPDATE orders SET reserved_until = now() - interval '1 second' WHERE id = $1`, [expired]);

    const result = await expiredSetup.invoicing.reconcile();

    expect(result.cancelled).toBeGreaterThanOrEqual(1);
    expect((await fx.order(expired))?.status).toBe('CANCELLED');
    expect((await fx.order(fresh))?.status).toBe('RESERVED');
    expect(await fx.inventory(sku)).toEqual({ available: 9, reserved: 1 });
  });

  it('reconciliation adopts an invoice for an order stuck in INVOICING', async () => {
    const erp = new FakeErp().failNext('createInvoice', 'timeout-after-create');
    const { services, invoicing } = setup(erp);
    const sku = await fx.sku({ available: 10 });
    const orderId = await placeOrder(services, sku);
    await invoicing.processOrder(orderId);
    await db.query(`UPDATE orders SET updated_at = now() - interval '1 hour' WHERE id = $1`, [orderId]);

    const result = await invoicing.reconcile();

    expect(result.adopted).toBeGreaterThanOrEqual(1);
    expect((await fx.order(orderId))?.status).toBe('INVOICED');
    expect(erp.invoicesFor(orderId)).toHaveLength(1);
  });
});
