import { type ErpClient, ErpError } from '../../shared/erp';
import type { Logger } from '../../shared/logger';
import { orderProcessingDuration } from '../../shared/metrics';
import { withSpan } from '../../shared/tracing';
import type { InvoicingOrder, InvoicingRepository } from './repository';

/** What the queue consumer should do with the message after handling it. */
export type HandleResult = { action: 'ack'; reason: string } | { action: 'retry'; delayS: number; reason: string };

export interface InvoicingService {
  /** Main-queue handler: invoice the order in the ERP exactly once despite retries and redeliveries. */
  processOrder(orderId: string): Promise<HandleResult>;
  /** DLQ handler: the order exhausted its attempts; settle it as INVOICED (if the ERP has it) or FAILED. */
  handleDeadLetter(orderId: string): Promise<HandleResult>;
  /** Periodic safety net for orders whose message was lost or whose worker died mid-flight. */
  reconcile(limit?: number): Promise<{ cancelled: number; adopted: number }>;
}

export interface BackoffOptions {
  baseS: number;
  maxS: number;
  maxAttempts: number;
}

/**
 * Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^(attempt-1))].
 * Full jitter spreads retries of many orders that failed together, so a recovering ERP is not hit in waves.
 */
export function computeBackoffS(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(attempt, 1), opts.maxAttempts) - 1;
  const ceiling = Math.min(opts.maxS, opts.baseS * 2 ** exponent);
  return Math.max(1, Math.round(random() * ceiling));
}

export interface InvoicingServiceDeps {
  repo: InvoicingRepository;
  erp: ErpClient;
  logger: Logger;
  backoff: BackoffOptions;
  stuckInvoicingAfterS: number;
  /** Must exceed the ERP timeout: how long one attempt may hold the order before another delivery may retry. */
  leaseS: number;
  random?: () => number;
  now?: () => number;
}

export function createInvoicingService(deps: InvoicingServiceDeps): InvoicingService {
  const now = deps.now ?? Date.now;

  function observeFinal(order: InvoicingOrder) {
    orderProcessingDuration.observe({ final_status: order.status }, (now() - order.createdAt.getTime()) / 1000);
  }

  async function adopt(orderId: string, invoiceId: string, source: string): Promise<HandleResult> {
    const res = await deps.repo.markInvoiced(orderId, invoiceId, { source });
    if (res.kind === 'done') {
      observeFinal(res.order);
      deps.logger.info({ orderId, invoiceId, source }, 'order invoiced');
    }
    return { action: 'ack', reason: `invoiced via ${source}` };
  }

  async function findExistingInvoice(orderId: string): Promise<string | undefined> {
    const invoices = await deps.erp.findInvoices(orderId);
    // Stryker disable next-line all: alert-only log for a duplicate that already happened; behaviour is the same
    if (invoices.length > 1) {
      deps.logger.error({ orderId, invoiceIds: invoices.map((i) => i.invoiceId) }, 'duplicate ERP invoices found');
    }
    return invoices[0]?.invoiceId;
  }

  return {
    processOrder(orderId) {
      return withSpan('order.process', { 'order.id': orderId }, async (span) => {
        const start = await deps.repo.startAttempt(orderId, deps.leaseS);
        if (start.kind === 'not_found') {
          deps.logger.warn({ orderId }, 'message for unknown order, discarding');
          return { action: 'ack', reason: 'order not found' };
        }
        if (start.kind === 'terminal') {
          // Redelivery or a late redrive after the reconciler settled the order: nothing to do, never re-invoice.
          return { action: 'ack', reason: `order already ${start.order.status}` };
        }
        if (start.kind === 'busy') {
          return { action: 'retry', delayS: Math.max(1, start.retryInS), reason: 'another attempt is in flight' };
        }
        const { order } = start;
        span.setAttribute('order.attempt', order.attempts);

        try {
          // POST /invoices is not idempotent. Any attempt after the first may follow a timeout where the ERP did
          // create the invoice, so look it up before creating another one.
          if (order.attempts > 1) {
            const existing = await findExistingInvoice(orderId);
            if (existing) return adopt(orderId, existing, 'lookup');
          }
          const invoice = await deps.erp.createInvoice(orderId, order.items);
          return adopt(orderId, invoice.invoiceId, 'create');
        } catch (err) {
          if (!(err instanceof ErpError)) throw err;
          if (!err.retryable) {
            const res = await deps.repo.releaseReservation(orderId, 'FAILED', err.message, ['INVOICING']);
            if (res.kind === 'done') observeFinal(res.order);
            deps.logger.error({ orderId, err: err.message }, 'ERP rejected the invoice, order failed');
            return { action: 'ack', reason: 'ERP rejected the invoice' };
          }
          await deps.repo.recordError(orderId, err.message);
          const delayS = computeBackoffS(order.attempts, deps.backoff, deps.random);
          deps.logger.warn(
            { orderId, attempt: order.attempts, delayS, err: err.message },
            'invoice failed, will retry',
          );
          return { action: 'retry', delayS, reason: err.message };
        }
      });
    },

    handleDeadLetter(orderId) {
      return withSpan('order.dead_letter', { 'order.id': orderId }, async () => {
        // A timed-out POST may still have produced an invoice: check before giving the stock back.
        let existing: string | undefined;
        try {
          existing = await findExistingInvoice(orderId);
        } catch (err) {
          if (!(err instanceof ErpError)) throw err;
          return { action: 'retry', delayS: deps.backoff.maxS, reason: 'ERP unavailable for DLQ lookup' };
        }
        if (existing) return adopt(orderId, existing, 'dlq-lookup');
        const res = await deps.repo.releaseReservation(orderId, 'FAILED', 'invoicing attempts exhausted', [
          'RESERVED',
          'INVOICING',
        ]);
        if (res.kind === 'done') {
          observeFinal(res.order);
          deps.logger.error({ orderId }, 'order failed after exhausting retries, reservation released');
        }
        return { action: 'ack', reason: 'order failed, reservation released' };
      });
    },

    async reconcile(limit = 50) {
      let cancelled = 0;
      let adopted = 0;
      const expired = await deps.repo.findExpiredReservations(limit);
      const stuck = await deps.repo.findStuckInvoicing(deps.stuckInvoicingAfterS, limit);
      for (const orderId of [...expired, ...stuck]) {
        try {
          const existing = await findExistingInvoice(orderId);
          if (existing) {
            await adopt(orderId, existing, 'reconciliation');
            adopted += 1;
            continue;
          }
          // Only never-started orders are cancelled here; INVOICING ones still have a message that will retry
          // or reach the DLQ, which settles them with the same lookup-first rule.
          // Stryker disable next-line ConditionalExpression: a stuck INVOICING order is refused by allowedFrom ['RESERVED'] anyway
          if (!expired.includes(orderId)) continue;
          const res = await deps.repo.releaseReservation(orderId, 'CANCELLED', 'reservation expired', ['RESERVED']);
          if (res.kind === 'done') {
            observeFinal(res.order);
            cancelled += 1;
          }
        } catch (err) {
          deps.logger.warn(
            { orderId, err: err instanceof Error ? err.message : String(err) },
            'reconciliation skipped',
          );
        }
      }
      // Stryker disable next-line all: log-only summary
      if (cancelled + adopted > 0) deps.logger.info({ cancelled, adopted }, 'reconciliation settled orders');
      return { cancelled, adopted };
    },
  };
}
