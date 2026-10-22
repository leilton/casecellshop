import { type Db, type DbClient, withTx } from '../../shared/db';
import type { OrderStatus } from '../checkout/schemas';

export interface OrderItem {
  sku: string;
  quantity: number;
}

export interface InvoicingOrder {
  orderId: string;
  status: OrderStatus;
  attempts: number;
  items: OrderItem[];
  invoiceId: string | null;
  createdAt: Date;
}

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['INVOICED', 'FAILED', 'CANCELLED'];

export type StartResult =
  | { kind: 'not_found' }
  | { kind: 'terminal'; order: InvoicingOrder }
  /** Another worker holds the invoicing lease (a concurrent duplicate delivery): try again later. */
  | { kind: 'busy'; retryInS: number }
  | { kind: 'started'; order: InvoicingOrder };

export type FinishResult =
  | { kind: 'not_found' }
  | { kind: 'already'; order: InvoicingOrder }
  | { kind: 'done'; order: InvoicingOrder };

export interface InvoicingRepository {
  /**
   * Moves RESERVED/INVOICING → INVOICING, counts the attempt and takes a lease of `leaseS` seconds.
   * Terminal orders are returned untouched; an order whose lease is still held is reported as busy.
   */
  startAttempt(orderId: string, leaseS: number): Promise<StartResult>;
  /** INVOICING/RESERVED → INVOICED and converts the reservation into a sale (`reserved -= q`). */
  markInvoiced(orderId: string, invoiceId: string, detail: Record<string, unknown>): Promise<FinishResult>;
  /** → FAILED or CANCELLED and gives the reserved units back (`available += q, reserved -= q`). */
  releaseReservation(
    orderId: string,
    to: 'FAILED' | 'CANCELLED',
    reason: string,
    allowedFrom: readonly OrderStatus[],
  ): Promise<FinishResult>;
  recordError(orderId: string, error: string): Promise<void>;
  findExpiredReservations(limit: number): Promise<string[]>;
  findStuckInvoicing(olderThanS: number, limit: number): Promise<string[]>;
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  attempts: number;
  items: OrderItem[];
  erp_invoice_id: string | null;
  created_at: Date;
  lease_remaining_s?: number;
}

function toOrder(row: OrderRow): InvoicingOrder {
  return {
    orderId: row.id,
    status: row.status,
    attempts: row.attempts,
    items: row.items.map(({ sku, quantity }) => ({ sku, quantity })),
    invoiceId: row.erp_invoice_id,
    createdAt: row.created_at,
  };
}

async function lockOrder(tx: DbClient, orderId: string): Promise<OrderRow | undefined> {
  // Row lock: a duplicate SQS delivery, the DLQ handler and the reconciler may touch the same order at once.
  const { rows } = await tx.query<OrderRow>(
    `SELECT id, status, attempts, items, erp_invoice_id, created_at,
            CEIL(GREATEST(EXTRACT(EPOCH FROM invoicing_lease_until - now()), 0))::int AS lease_remaining_s
     FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0];
}

async function addEvent(tx: DbClient, orderId: string, from: OrderStatus, to: OrderStatus, detail: unknown) {
  await tx.query('INSERT INTO order_events (order_id, from_status, to_status, detail) VALUES ($1, $2, $3, $4)', [
    orderId,
    from,
    to,
    JSON.stringify(detail),
  ]);
}

function sortedItems(items: OrderItem[]): OrderItem[] {
  return [...items].sort((a, b) => a.sku.localeCompare(b.sku));
}

export function createInvoicingRepository(db: Db): InvoicingRepository {
  return {
    startAttempt: (orderId, leaseS) =>
      withTx(db, async (tx): Promise<StartResult> => {
        const row = await lockOrder(tx, orderId);
        if (!row) return { kind: 'not_found' };
        if (TERMINAL_STATUSES.includes(row.status)) return { kind: 'terminal', order: toOrder(row) };
        if (row.status === 'INVOICING' && (row.lease_remaining_s ?? 0) > 0) {
          return { kind: 'busy', retryInS: row.lease_remaining_s ?? leaseS };
        }
        const { rows } = await tx.query<OrderRow>(
          `UPDATE orders SET status = 'INVOICING', attempts = attempts + 1, updated_at = now(),
             invoicing_lease_until = now() + make_interval(secs => $2)
           WHERE id = $1 RETURNING id, status, attempts, items, erp_invoice_id, created_at`,
          [orderId, leaseS],
        );
        const updated = rows[0] ?? row;
        if (row.status !== 'INVOICING') {
          await addEvent(tx, orderId, row.status, 'INVOICING', { attempt: updated.attempts });
        }
        return { kind: 'started', order: toOrder(updated) };
      }),

    markInvoiced: (orderId, invoiceId, detail) =>
      withTx(db, async (tx): Promise<FinishResult> => {
        const row = await lockOrder(tx, orderId);
        if (!row) return { kind: 'not_found' };
        if (row.status === 'INVOICED') return { kind: 'already', order: toOrder(row) };
        // The ERP is the fiscal source of truth: an invoice that exists wins even over a FAILED/CANCELLED order,
        // but then the units were already released, so only take them from `available` if still reserved.
        const wasReserved = row.status === 'RESERVED' || row.status === 'INVOICING';
        for (const item of sortedItems(row.items)) {
          if (wasReserved) {
            await tx.query(
              'UPDATE inventory SET reserved = reserved - $2, updated_at = now() WHERE sku = $1 AND reserved >= $2',
              [item.sku, item.quantity],
            );
          } else {
            await tx.query(
              'UPDATE inventory SET available = GREATEST(available - $2, 0), updated_at = now() WHERE sku = $1',
              [item.sku, item.quantity],
            );
          }
        }
        const { rows } = await tx.query<OrderRow>(
          `UPDATE orders SET status = 'INVOICED', erp_invoice_id = $2, last_error = NULL, updated_at = now(),
             invoicing_lease_until = NULL
           WHERE id = $1 RETURNING id, status, attempts, items, erp_invoice_id, created_at`,
          [orderId, invoiceId],
        );
        await addEvent(tx, orderId, row.status, 'INVOICED', { invoiceId, ...detail });
        return { kind: 'done', order: toOrder(rows[0] ?? row) };
      }),

    releaseReservation: (orderId, to, reason, allowedFrom) =>
      withTx(db, async (tx): Promise<FinishResult> => {
        const row = await lockOrder(tx, orderId);
        if (!row) return { kind: 'not_found' };
        if (!allowedFrom.includes(row.status)) return { kind: 'already', order: toOrder(row) };
        for (const item of sortedItems(row.items)) {
          await tx.query(
            `UPDATE inventory SET available = available + $2, reserved = reserved - $2, updated_at = now()
             WHERE sku = $1 AND reserved >= $2`,
            [item.sku, item.quantity],
          );
        }
        const { rows } = await tx.query<OrderRow>(
          `UPDATE orders SET status = $2, last_error = $3, updated_at = now(), invoicing_lease_until = NULL
           WHERE id = $1 RETURNING id, status, attempts, items, erp_invoice_id, created_at`,
          [orderId, to, reason],
        );
        await addEvent(tx, orderId, row.status, to, { reason, released: true });
        return { kind: 'done', order: toOrder(rows[0] ?? row) };
      }),

    async recordError(orderId, error) {
      // Releasing the lease lets the next delivery (after its backoff) proceed straight away.
      await db.query(
        'UPDATE orders SET last_error = $2, updated_at = now(), invoicing_lease_until = NULL WHERE id = $1',
        [orderId, error],
      );
    },

    async findExpiredReservations(limit) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM orders WHERE status = 'RESERVED' AND reserved_until < now() ORDER BY reserved_until LIMIT $1`,
        [limit],
      );
      return rows.map((r) => r.id);
    },

    async findStuckInvoicing(olderThanS, limit) {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM orders WHERE status = 'INVOICING' AND updated_at < now() - make_interval(secs => $1)
         ORDER BY updated_at LIMIT $2`,
        [olderThanS, limit],
      );
      return rows.map((r) => r.id);
    },
  };
}
