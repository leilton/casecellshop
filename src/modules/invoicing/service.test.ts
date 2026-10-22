import { describe, expect, it } from 'vitest';
import { FakeErp } from '../../../tests/support/fake-erp';
import { silentLogger } from '../../../tests/support/fakes';
import { histogramCount } from '../../../tests/support/metrics';
import { orderProcessingDuration } from '../../shared/metrics';
import type { OrderStatus } from '../checkout/schemas';
import type { FinishResult, InvoicingOrder, InvoicingRepository, StartResult } from './repository';
import { TERMINAL_STATUSES } from './repository';
import { computeBackoffS, createInvoicingService } from './service';

const ORDER = 'b2c1f2a8-1d3e-4c5f-8a9b-0c1d2e3f4a5b';
const backoff = { baseS: 2, maxS: 60, maxAttempts: 5 };

/** In-memory twin of the repository: same state machine, no SQL. */
class MemoryInvoicingRepo implements InvoicingRepository {
  orders = new Map<
    string,
    InvoicingOrder & { lastError?: string; released?: boolean; expired?: boolean; stuck?: boolean; leased?: boolean }
  >();

  add(
    status: OrderStatus = 'RESERVED',
    patch: Partial<InvoicingOrder> & { expired?: boolean; stuck?: boolean; leased?: boolean } = {},
  ) {
    const order = {
      orderId: ORDER,
      status,
      attempts: 0,
      items: [{ sku: 'CASE-A', quantity: 1 }],
      invoiceId: null,
      createdAt: new Date(Date.now() - 5000),
      ...patch,
    };
    this.orders.set(order.orderId, order);
    return order;
  }

  get(id = ORDER) {
    const o = this.orders.get(id);
    if (!o) throw new Error('missing');
    return o;
  }

  async startAttempt(orderId: string, leaseS: number): Promise<StartResult> {
    const o = this.orders.get(orderId);
    if (!o) return { kind: 'not_found' };
    if (TERMINAL_STATUSES.includes(o.status)) return { kind: 'terminal', order: { ...o } };
    if (o.status === 'INVOICING' && o.leased) return { kind: 'busy', retryInS: leaseS };
    o.leased = true;
    o.status = 'INVOICING';
    o.attempts += 1;
    return { kind: 'started', order: { ...o } };
  }

  async markInvoiced(orderId: string, invoiceId: string): Promise<FinishResult> {
    const o = this.orders.get(orderId);
    if (!o) return { kind: 'not_found' };
    if (o.status === 'INVOICED') return { kind: 'already', order: { ...o } };
    o.status = 'INVOICED';
    o.invoiceId = invoiceId;
    o.leased = false;
    return { kind: 'done', order: { ...o } };
  }

  async releaseReservation(
    orderId: string,
    to: 'FAILED' | 'CANCELLED',
    reason: string,
    allowedFrom: readonly OrderStatus[],
  ): Promise<FinishResult> {
    const o = this.orders.get(orderId);
    if (!o) return { kind: 'not_found' };
    if (!allowedFrom.includes(o.status)) return { kind: 'already', order: { ...o } };
    o.status = to;
    o.lastError = reason;
    o.released = true;
    o.leased = false;
    return { kind: 'done', order: { ...o } };
  }

  async recordError(orderId: string, error: string) {
    const o = this.orders.get(orderId);
    if (o) {
      o.lastError = error;
      o.leased = false;
    }
  }

  async findExpiredReservations() {
    return [...this.orders.values()].filter((o) => o.status === 'RESERVED' && o.expired).map((o) => o.orderId);
  }

  async findStuckInvoicing() {
    return [...this.orders.values()].filter((o) => o.status === 'INVOICING' && o.stuck).map((o) => o.orderId);
  }
}

function setup(erp = new FakeErp(), now?: () => number) {
  const repo = new MemoryInvoicingRepo();
  const service = createInvoicingService({
    repo,
    erp,
    logger: silentLogger,
    backoff,
    stuckInvoicingAfterS: 120,
    leaseS: 15,
    random: () => 1,
    ...(now ? { now } : {}),
  });
  return { repo, erp, service };
}

async function durationSum(finalStatus: string): Promise<number> {
  const { values } = await orderProcessingDuration.get();
  const sum = values.find((v) => v.metricName?.endsWith('_sum') && v.labels.final_status === finalStatus);
  return sum?.value ?? 0;
}

describe('computeBackoffS', () => {
  it('grows exponentially, is capped, and never drops below 1s', () => {
    const top = () => 0.999999;
    expect([1, 2, 3, 4, 5].map((a) => computeBackoffS(a, backoff, top))).toEqual([2, 4, 8, 16, 32]);
    expect(computeBackoffS(5, { baseS: 10, maxS: 60, maxAttempts: 5 }, top)).toBe(60);
    expect(computeBackoffS(50, backoff, top)).toBe(32); // exponent stops at maxAttempts
    expect(computeBackoffS(3, backoff, () => 0)).toBe(1);
  });

  it('uses full jitter: every delay lies in [1, ceiling]', () => {
    for (let i = 0; i < 200; i++) {
      const d = computeBackoffS(4, backoff);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(16);
    }
  });
});

describe('invoicing service — processOrder', () => {
  it('invoices on the first attempt without a lookup', async () => {
    const { repo, erp, service } = setup();
    repo.add();

    expect(await service.processOrder(ORDER)).toMatchObject({ action: 'ack' });
    expect(repo.get().status).toBe('INVOICED');
    expect(erp.calls).toMatchObject({ createInvoice: 1, findInvoices: 0 });
  });

  it('schedules a retry with backoff on a transient ERP failure and records the error', async () => {
    const { repo, erp, service } = setup(new FakeErp().failNext('createInvoice', 'unavailable'));
    repo.add();

    const result = await service.processOrder(ORDER);

    expect(result).toEqual({ action: 'retry', delayS: 2, reason: expect.stringContaining('unavailable') });
    expect(repo.get()).toMatchObject({ status: 'INVOICING', attempts: 1 });
    expect(repo.get().lastError).toContain('unavailable');
    expect(erp.invoices).toHaveLength(0);
  });

  it('adopts the invoice created by a timed-out attempt instead of creating a second one', async () => {
    const { repo, erp, service } = setup(new FakeErp().failNext('createInvoice', 'timeout-after-create'));
    repo.add();

    expect(await service.processOrder(ORDER)).toMatchObject({ action: 'retry' });
    expect(await service.processOrder(ORDER)).toMatchObject({ action: 'ack', reason: 'invoiced via lookup' });

    expect(erp.invoicesFor(ORDER)).toHaveLength(1);
    expect(erp.calls.createInvoice).toBe(1);
    expect(repo.get()).toMatchObject({ status: 'INVOICED', invoiceId: erp.invoices[0]?.invoiceId });
  });

  it('does not create blindly when the lookup itself fails: it retries later', async () => {
    const erp = new FakeErp().failNext('createInvoice', 'timeout-after-create').failNext('findInvoices', 'timeout');
    const { repo, service } = setup(erp);
    repo.add();

    await service.processOrder(ORDER);
    expect(await service.processOrder(ORDER)).toMatchObject({ action: 'retry' });
    expect(erp.calls.createInvoice).toBe(1);
    expect(erp.invoicesFor(ORDER)).toHaveLength(1);
  });

  it('fails the order and releases stock when the ERP rejects the invoice (4xx, not retryable)', async () => {
    const { repo, service } = setup(new FakeErp().failNext('createInvoice', 'client'));
    repo.add();

    expect(await service.processOrder(ORDER)).toMatchObject({ action: 'ack' });
    expect(repo.get()).toMatchObject({ status: 'FAILED', released: true });
  });

  it.each(['INVOICED', 'FAILED', 'CANCELLED'] as const)(
    'acks a redelivered message for a %s order without calling the ERP',
    async (status) => {
      const { repo, erp, service } = setup();
      repo.add(status);

      expect(await service.processOrder(ORDER)).toMatchObject({ action: 'ack' });
      expect(erp.calls).toEqual({ listProducts: 0, createInvoice: 0, findInvoices: 0 });
    },
  );

  it('backs off when another delivery of the same order holds the invoicing lease', async () => {
    const { repo, erp, service } = setup();
    repo.add('INVOICING', { attempts: 1, leased: true });

    expect(await service.processOrder(ORDER)).toEqual({
      action: 'retry',
      delayS: 15,
      reason: 'another attempt is in flight',
    });
    expect(erp.calls.createInvoice + erp.calls.findInvoices).toBe(0);
    expect(repo.get().attempts).toBe(1);
  });

  it('acks a message for an unknown order', async () => {
    const { service } = setup();

    expect(await service.processOrder(ORDER)).toEqual({ action: 'ack', reason: 'order not found' });
  });

  it('propagates non-ERP failures so the message is not deleted', async () => {
    const { repo, service } = setup();
    repo.add();
    repo.markInvoiced = async () => {
      throw new Error('db down');
    };

    await expect(service.processOrder(ORDER)).rejects.toThrow('db down');
  });
});

describe('invoicing service — non-ERP failures', () => {
  it('a bug in the ERP client propagates instead of failing the order and releasing stock', async () => {
    const erp = new FakeErp();
    erp.createInvoice = async () => {
      throw new TypeError('client bug');
    };
    const { repo, service } = setup(erp);
    repo.add();

    await expect(service.processOrder(ORDER)).rejects.toThrow('client bug');
    expect(repo.get()).toMatchObject({ status: 'INVOICING' });
    expect(repo.get().released).toBeUndefined();
  });

  it('a bug during the DLQ lookup propagates instead of being retried as an ERP outage', async () => {
    const erp = new FakeErp();
    erp.findInvoices = async () => {
      throw new TypeError('client bug');
    };
    const { repo, service } = setup(erp);
    repo.add('INVOICING');

    await expect(service.handleDeadLetter(ORDER)).rejects.toThrow('client bug');
    expect(repo.get().status).toBe('INVOICING');
  });
});

describe('invoicing service — final-status duration metric', () => {
  const CREATED = 1_000_000;
  const clock = () => CREATED + 5_000;

  it('observes the time from order creation to INVOICED, in seconds, once', async () => {
    const { repo, service } = setup(new FakeErp(), clock);
    repo.add('RESERVED', { createdAt: new Date(CREATED) });
    const before = {
      n: await histogramCount(orderProcessingDuration, { final_status: 'INVOICED' }),
      sum: await durationSum('INVOICED'),
    };

    await service.processOrder(ORDER);

    expect(await histogramCount(orderProcessingDuration, { final_status: 'INVOICED' })).toBe(before.n + 1);
    expect(await durationSum('INVOICED')).toBeCloseTo(before.sum + 5);
  });

  it('does not observe again when the order was already settled', async () => {
    const erp = new FakeErp();
    erp.invoices.push({ invoiceId: 'inv-1', orderId: ORDER, createdAt: new Date().toISOString() });
    const { repo, service } = setup(erp, clock);
    repo.add('INVOICED', { createdAt: new Date(CREATED), invoiceId: 'inv-1' });
    const before = await histogramCount(orderProcessingDuration, { final_status: 'INVOICED' });

    await service.handleDeadLetter(ORDER);

    expect(await histogramCount(orderProcessingDuration, { final_status: 'INVOICED' })).toBe(before);
  });

  it('observes FAILED once for an ERP rejection, and not when the release found nothing to do', async () => {
    const { repo, service } = setup(new FakeErp().failAlways('createInvoice', 'client'), clock);
    repo.add('RESERVED', { createdAt: new Date(CREATED) });
    const before = await histogramCount(orderProcessingDuration, { final_status: 'FAILED' });

    await service.processOrder(ORDER);
    expect(await histogramCount(orderProcessingDuration, { final_status: 'FAILED' })).toBe(before + 1);

    repo.add('RESERVED', { createdAt: new Date(CREATED) });
    // A concurrent settlement got there first: the order is already final, so it must not be observed twice.
    repo.releaseReservation = async () => ({ kind: 'already', order: { ...repo.get(), status: 'FAILED' } });
    expect(await service.processOrder(ORDER)).toEqual({ action: 'ack', reason: 'ERP rejected the invoice' });
    expect(await histogramCount(orderProcessingDuration, { final_status: 'FAILED' })).toBe(before + 1);
  });

  it('observes a dead-letter failure once; a DLQ message for an already cancelled order observes nothing', async () => {
    const { repo, service } = setup(new FakeErp(), clock);
    repo.add('INVOICING', { createdAt: new Date(CREATED) });
    const before = await histogramCount(orderProcessingDuration, { final_status: 'FAILED' });

    expect(await service.handleDeadLetter(ORDER)).toEqual({
      action: 'ack',
      reason: 'order failed, reservation released',
    });
    expect(await histogramCount(orderProcessingDuration, { final_status: 'FAILED' })).toBe(before + 1);

    repo.add('CANCELLED', { createdAt: new Date(CREATED) });
    const cancelledBefore = await histogramCount(orderProcessingDuration, { final_status: 'CANCELLED' });
    await service.handleDeadLetter(ORDER);
    expect(await histogramCount(orderProcessingDuration, { final_status: 'CANCELLED' })).toBe(cancelledBefore);
    expect(await histogramCount(orderProcessingDuration, { final_status: 'FAILED' })).toBe(before + 1);
    expect(repo.get().status).toBe('CANCELLED');
  });

  it('reconciliation counts only the reservations it actually cancelled', async () => {
    const { repo, service } = setup(new FakeErp(), clock);
    repo.add('RESERVED', { expired: true, createdAt: new Date(CREATED) });
    repo.releaseReservation = async () => ({ kind: 'already', order: repo.get() });

    expect(await service.reconcile()).toEqual({ cancelled: 0, adopted: 0 });
  });
});

describe('invoicing service — dead letters', () => {
  it('fails an order that never got an attempt (still RESERVED) and releases it', async () => {
    const { repo, service } = setup();
    repo.add('RESERVED');

    await service.handleDeadLetter(ORDER);

    expect(repo.get()).toMatchObject({ status: 'FAILED', released: true, lastError: 'invoicing attempts exhausted' });
  });

  it('fails the order and releases the reservation when the ERP has no invoice', async () => {
    const { repo, service } = setup();
    repo.add('INVOICING', { attempts: 5 });

    expect(await service.handleDeadLetter(ORDER)).toMatchObject({ action: 'ack' });
    expect(repo.get()).toMatchObject({ status: 'FAILED', released: true });
  });

  it('adopts an invoice found in the ERP instead of failing a paid order', async () => {
    const erp = new FakeErp();
    erp.invoices.push({ invoiceId: 'inv-1', orderId: ORDER, createdAt: new Date().toISOString() });
    const { repo, service } = setup(erp);
    repo.add('INVOICING', { attempts: 5 });

    expect(await service.handleDeadLetter(ORDER)).toMatchObject({ action: 'ack' });
    expect(repo.get()).toMatchObject({ status: 'INVOICED', invoiceId: 'inv-1' });
    expect(repo.get().released).toBeUndefined();
  });

  it('keeps the DLQ message when the ERP is down (cannot know if it was invoiced)', async () => {
    const { repo, service } = setup(new FakeErp().failNext('findInvoices', 'unavailable'));
    repo.add('INVOICING');

    expect(await service.handleDeadLetter(ORDER)).toEqual({
      action: 'retry',
      delayS: 60,
      reason: 'ERP unavailable for DLQ lookup',
    });
    expect(repo.get().status).toBe('INVOICING');
  });
});

describe('invoicing service — reconciliation', () => {
  it('cancels expired reservations without an invoice and adopts stuck orders that were invoiced', async () => {
    const erp = new FakeErp();
    const { repo, service } = setup(erp);
    const stuckId = 'c3d2e1f0-0000-4000-8000-000000000001';
    repo.add('RESERVED', { expired: true });
    repo.add('INVOICING', { orderId: stuckId, stuck: true });
    erp.invoices.push({ invoiceId: 'inv-stuck', orderId: stuckId, createdAt: new Date().toISOString() });

    expect(await service.reconcile()).toEqual({ cancelled: 1, adopted: 1 });
    expect(repo.get()).toMatchObject({ status: 'CANCELLED', released: true });
    expect(repo.get(stuckId)).toMatchObject({ status: 'INVOICED', invoiceId: 'inv-stuck' });
  });

  it('leaves fresh reservations and stuck orders without an invoice alone', async () => {
    const { repo, service } = setup();
    repo.add('RESERVED');
    repo.add('INVOICING', { orderId: 'c3d2e1f0-0000-4000-8000-000000000002', stuck: true });

    expect(await service.reconcile()).toEqual({ cancelled: 0, adopted: 0 });
    expect(repo.get().status).toBe('RESERVED');
  });

  it('skips an order when the ERP is unavailable and keeps going', async () => {
    const { repo, service } = setup(new FakeErp().failNext('findInvoices', 'timeout'));
    repo.add('RESERVED', { expired: true });

    expect(await service.reconcile()).toEqual({ cancelled: 0, adopted: 0 });
    expect(repo.get().status).toBe('RESERVED');
  });
});
