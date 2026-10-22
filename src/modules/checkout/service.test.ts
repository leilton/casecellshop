import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../tests/support/fakes';
import { counterValue } from '../../../tests/support/metrics';
import { checkoutRequests, stockReservationConflicts } from '../../shared/metrics';
import type { CheckoutRepository, PlaceOrderInput, PlaceOrderResult } from './repository';
import { createCheckoutService, hashCheckoutRequest, outOfStockMessage } from './service';

const ORDER_ID = '7d4f0c3a-8a6b-4c55-9a43-1f6f5f2b1a10';

function setup(result: (input: PlaceOrderInput) => PlaceOrderResult) {
  const placeOrder = vi.fn(async (input: PlaceOrderInput) => result(input));
  const repo: CheckoutRepository = { placeOrder };
  const priceFor = vi.fn(async (skus: string[]) =>
    skus.filter((s) => s !== 'CASE-UNKNOWN').map((sku) => ({ sku, name: sku, priceCents: 2500 })),
  );
  const service = createCheckoutService({ repo, catalog: { priceFor }, logger: silentLogger, reservationTtlS: 900 });
  return { service, placeOrder, priceFor };
}

const cmd = (items = [{ sku: 'CASE-A', quantity: 2 }]) => ({ idempotencyKey: 'key-1', items, correlationId: 'corr-1' });

describe('outOfStockMessage', () => {
  it('tells how many are left when some stock remains', () => {
    expect(outOfStockMessage([{ sku: 'CASE-S24-BLU', requested: 3, available: 2 }])).toBe(
      'Only 2 left of CASE-S24-BLU (you asked for 3). Nothing was reserved; adjust the quantity and try again.',
    );
  });

  it('says sold out when nothing remains', () => {
    expect(outOfStockMessage([{ sku: 'CASE-S24-RED', requested: 1, available: 0 }])).toBe(
      'CASE-S24-RED is sold out. Nothing was reserved; adjust the quantity and try again.',
    );
  });

  it('joins several short SKUs into one sentence', () => {
    expect(
      outOfStockMessage([
        { sku: 'CASE-S24-RED', requested: 1, available: 0 },
        { sku: 'CASE-S24-BLU', requested: 4, available: 3 },
      ]),
    ).toBe(
      'CASE-S24-RED is sold out; only 3 left of CASE-S24-BLU (you asked for 4). Nothing was reserved; adjust the quantity and try again.',
    );
  });
});

describe('hashCheckoutRequest', () => {
  it('ignores item order but not quantities', () => {
    const a = hashCheckoutRequest([
      { sku: 'CASE-A', quantity: 1 },
      { sku: 'CASE-B', quantity: 2 },
    ]);
    const b = hashCheckoutRequest([
      { sku: 'CASE-B', quantity: 2 },
      { sku: 'CASE-A', quantity: 1 },
    ]);
    const c = hashCheckoutRequest([
      { sku: 'CASE-A', quantity: 2 },
      { sku: 'CASE-B', quantity: 2 },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('checkout service', () => {
  it('prices items on the server and passes the reservation TTL and correlation to the repository', async () => {
    const { service, placeOrder } = setup(() => ({ kind: 'created', orderId: ORDER_ID, status: 'RESERVED' }));

    const out = await service.place(cmd());

    expect(out).toEqual({
      duplicate: false,
      accepted: { orderId: ORDER_ID, status: 'RESERVED', statusUrl: `/orders/${ORDER_ID}/status` },
    });
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ sku: 'CASE-A', quantity: 2, priceCents: 2500 }],
        totalCents: 5000,
        reservationTtlS: 900,
        correlationId: 'corr-1',
        message: expect.objectContaining({ correlationId: 'corr-1' }),
      }),
    );
  });

  it('counts an accepted checkout', async () => {
    const { service } = setup(() => ({ kind: 'created', orderId: ORDER_ID, status: 'RESERVED' }));
    const before = await counterValue(checkoutRequests, { outcome: 'accepted' });

    await service.place(cmd());

    expect(await counterValue(checkoutRequests, { outcome: 'accepted' })).toBe(before + 1);
  });

  it('returns the original order for a repeated request with the same key and payload', async () => {
    const { service } = setup((input) => ({
      kind: 'existing',
      orderId: ORDER_ID,
      status: 'INVOICING',
      requestHash: input.requestHash,
    }));
    const before = await counterValue(checkoutRequests, { outcome: 'duplicate' });

    const out = await service.place(cmd());

    expect(out.duplicate).toBe(true);
    expect(out.accepted).toMatchObject({ orderId: ORDER_ID, status: 'INVOICING' });
    expect(await counterValue(checkoutRequests, { outcome: 'duplicate' })).toBe(before + 1);
  });

  it('rejects the same key with a different payload (422)', async () => {
    const { service } = setup(() => ({
      kind: 'existing',
      orderId: ORDER_ID,
      status: 'RESERVED',
      requestHash: 'other',
    }));

    await expect(service.place(cmd())).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
  });

  it('rejects unknown SKUs before touching stock (422)', async () => {
    const { service, placeOrder } = setup(() => ({ kind: 'created', orderId: ORDER_ID, status: 'RESERVED' }));

    await expect(service.place(cmd([{ sku: 'CASE-UNKNOWN', quantity: 1 }]))).rejects.toMatchObject({
      code: 'UNKNOWN_SKU',
      httpStatus: 422,
      details: { skus: ['CASE-UNKNOWN'] },
    });
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('maps a failed reservation to 409 with what is left per SKU and counts a conflict per SKU', async () => {
    const short = [
      { sku: 'CASE-A', requested: 2, available: 1 },
      { sku: 'CASE-B', requested: 1, available: 0 },
    ];
    const { service } = setup(() => ({ kind: 'out_of_stock', items: short }));
    const before = {
      a: await counterValue(stockReservationConflicts, { sku: 'CASE-A' }),
      b: await counterValue(stockReservationConflicts, { sku: 'CASE-B' }),
    };

    await expect(
      service.place(
        cmd([
          { sku: 'CASE-A', quantity: 2 },
          { sku: 'CASE-B', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'OUT_OF_STOCK',
      httpStatus: 409,
      details: { skus: ['CASE-A', 'CASE-B'], items: short },
    });
    expect(await counterValue(stockReservationConflicts, { sku: 'CASE-A' })).toBe(before.a + 1);
    expect(await counterValue(stockReservationConflicts, { sku: 'CASE-B' })).toBe(before.b + 1);
  });

  it('propagates repository failures unchanged', async () => {
    const { service } = setup(() => {
      throw new Error('db down');
    });

    await expect(service.place(cmd())).rejects.toThrow('db down');
  });
});
