import { describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../../tests/support/fakes';
import { counterValue } from '../../../tests/support/metrics';
import { orderCancellations } from '../../shared/metrics';
import type { CancelResult, OrdersRepository } from './repository';
import type { OrderStatusResponse } from './schemas';
import { CUSTOMER_CANCEL_REASON, createOrdersService } from './service';

const ORDER_ID = '7d4f0c3a-8a6b-4c55-9a43-1f6f5f2b1a10';

const cancelled: OrderStatusResponse = {
  orderId: ORDER_ID,
  status: 'CANCELLED',
  totalCents: 5000,
  items: [{ sku: 'CASE-A', quantity: 2, priceCents: 2500 }],
  invoiceId: null,
  attempts: 0,
  lastError: CUSTOMER_CANCEL_REASON,
  reservedUntil: null,
  createdAt: '2026-10-22T10:00:00.000Z',
  updatedAt: '2026-10-22T10:01:00.000Z',
  history: [],
};

function setup(result: CancelResult, found: OrderStatusResponse | null = cancelled) {
  const cancelReserved = vi.fn(async () => result);
  const findStatus = vi.fn(async () => found ?? undefined);
  const repo: OrdersRepository = { cancelReserved, findStatus };
  return { service: createOrdersService({ repo, logger: silentLogger }), cancelReserved };
}

describe('OrdersService.cancel', () => {
  it('cancels a reserved order with the customer reason and returns its current status', async () => {
    const { service, cancelReserved } = setup({ kind: 'cancelled' });
    const before = await counterValue(orderCancellations, { outcome: 'cancelled' });

    await expect(service.cancel(ORDER_ID)).resolves.toEqual(cancelled);

    expect(cancelReserved).toHaveBeenCalledWith(ORDER_ID, CUSTOMER_CANCEL_REASON);
    expect(await counterValue(orderCancellations, { outcome: 'cancelled' })).toBe(before + 1);
  });

  it('answers an already cancelled order like the first cancel (idempotent by state)', async () => {
    const { service } = setup({ kind: 'already_cancelled' });
    const before = await counterValue(orderCancellations, { outcome: 'already_cancelled' });

    await expect(service.cancel(ORDER_ID)).resolves.toEqual(cancelled);

    expect(await counterValue(orderCancellations, { outcome: 'already_cancelled' })).toBe(before + 1);
  });

  it.each(['INVOICING', 'INVOICED', 'FAILED'] as const)('refuses an order that is %s with 409', async (status) => {
    const { service } = setup({ kind: 'not_cancellable', status });
    const before = await counterValue(orderCancellations, { outcome: 'not_cancellable' });

    await expect(service.cancel(ORDER_ID)).rejects.toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
      httpStatus: 409,
      details: { status },
    });
    expect(await counterValue(orderCancellations, { outcome: 'not_cancellable' })).toBe(before + 1);
  });

  it('returns 404 for an unknown order', async () => {
    const { service } = setup({ kind: 'not_found' });
    const before = await counterValue(orderCancellations, { outcome: 'not_found' });

    await expect(service.cancel(ORDER_ID)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', httpStatus: 404 });
    expect(await counterValue(orderCancellations, { outcome: 'not_found' })).toBe(before + 1);
  });
});

describe('OrdersService.getStatus', () => {
  it('returns 404 when the order does not exist', async () => {
    const { service } = setup({ kind: 'not_found' }, null);
    await expect(service.getStatus(ORDER_ID)).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND', httpStatus: 404 });
  });
});
