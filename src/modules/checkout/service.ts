import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import { type CheckoutOutcome, checkoutRequests, stockReservationConflicts } from '../../shared/metrics';
import { injectTraceContext, withSpan } from '../../shared/tracing';
import type { CatalogService } from '../catalog/service';
import type { CheckoutRepository } from './repository';
import type { CheckoutAccepted, CheckoutItem } from './schemas';

export interface CheckoutServiceDeps {
  repo: CheckoutRepository;
  catalog: Pick<CatalogService, 'priceFor'>;
  logger: Logger;
  reservationTtlS: number;
}

export interface PlaceOrderCommand {
  idempotencyKey: string;
  items: CheckoutItem[];
  correlationId: string;
}

export interface PlaceOrderOutcome {
  accepted: CheckoutAccepted;
  duplicate: boolean;
}

export interface CheckoutService {
  place(cmd: PlaceOrderCommand): Promise<PlaceOrderOutcome>;
}

/** Order-insensitive hash so that `[A, B]` and `[B, A]` count as the same request for idempotency. */
export function hashCheckoutRequest(items: CheckoutItem[]): string {
  const canonical = [...items]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((i) => `${i.sku}:${i.quantity}`)
    .join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export function statusUrl(orderId: string): string {
  return `/orders/${orderId}/status`;
}

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  function count(outcome: CheckoutOutcome) {
    checkoutRequests.inc({ outcome });
  }

  return {
    async place(cmd) {
      const requestHash = hashCheckoutRequest(cmd.items);
      const skus = cmd.items.map((i) => i.sku);

      const priced = new Map((await deps.catalog.priceFor(skus)).map((p) => [p.sku, p]));
      const unknown = skus.filter((s) => !priced.has(s));
      if (unknown.length > 0) {
        count('invalid');
        throw new AppError('UNKNOWN_SKU', 422, `Unknown sku: ${unknown.join(', ')}`, { skus: unknown });
      }

      const items = cmd.items.map((i) => ({ ...i, priceCents: priced.get(i.sku)?.priceCents ?? 0 }));
      const totalCents = items.reduce((sum, i) => sum + i.priceCents * i.quantity, 0);

      const result = await withSpan('stock.reserve', { 'checkout.items': items.length }, async (span) => {
        const r = await deps.repo.placeOrder({
          idempotencyKey: cmd.idempotencyKey,
          requestHash,
          items,
          totalCents,
          correlationId: cmd.correlationId,
          reservationTtlS: deps.reservationTtlS,
          // The trace context rides in the outbox so the worker's spans join this request's trace.
          message: { correlationId: cmd.correlationId, trace: injectTraceContext() },
        });
        span.setAttribute('checkout.result', r.kind);
        if (r.kind !== 'out_of_stock') span.setAttribute('order.id', r.orderId);
        return r;
      });

      switch (result.kind) {
        case 'created':
          count('accepted');
          deps.logger.info({ orderId: result.orderId, totalCents }, 'order placed, stock reserved');
          return {
            duplicate: false,
            accepted: { orderId: result.orderId, status: result.status, statusUrl: statusUrl(result.orderId) },
          };
        case 'existing':
          if (result.requestHash !== requestHash) {
            count('invalid');
            throw new AppError(
              'IDEMPOTENCY_KEY_REUSED',
              422,
              'This Idempotency-Key was already used with a different payload',
            );
          }
          count('duplicate');
          return {
            duplicate: true,
            accepted: { orderId: result.orderId, status: result.status, statusUrl: statusUrl(result.orderId) },
          };
        case 'out_of_stock':
          count('out_of_stock');
          for (const sku of result.skus) stockReservationConflicts.inc({ sku });
          throw new AppError('OUT_OF_STOCK', 409, `Not enough stock for: ${result.skus.join(', ')}`, {
            skus: result.skus,
          });
      }
    },
  };
}
