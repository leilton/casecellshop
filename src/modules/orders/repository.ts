import { type Db, withTx } from '../../shared/db';
import type { OrderStatus } from '../checkout/schemas';
import type { OrderStatusResponse } from './schemas';

export type CancelResult =
  | { kind: 'not_found' }
  | { kind: 'cancelled' }
  | { kind: 'already_cancelled' }
  | { kind: 'not_cancellable'; status: OrderStatus };

export interface OrdersRepository {
  findStatus(orderId: string): Promise<OrderStatusResponse | undefined>;
  /** RESERVED → CANCELLED and gives the reserved units back (`available += q, reserved -= q`), atomically. */
  cancelReserved(orderId: string, reason: string): Promise<CancelResult>;
}

interface OrderRow {
  id: string;
  status: OrderStatus;
  total_cents: number;
  items: OrderStatusResponse['items'];
  erp_invoice_id: string | null;
  attempts: number;
  last_error: string | null;
  reserved_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  detail: unknown;
  created_at: Date;
}

export function createOrdersRepository(db: Db): OrdersRepository {
  return {
    async findStatus(orderId) {
      const { rows } = await db.query<OrderRow>(
        `SELECT id, status, total_cents, items, erp_invoice_id, attempts, last_error, reserved_until, created_at, updated_at
         FROM orders WHERE id = $1`,
        [orderId],
      );
      const order = rows[0];
      if (!order) return undefined;
      const events = await db.query<EventRow>(
        'SELECT from_status, to_status, detail, created_at FROM order_events WHERE order_id = $1 ORDER BY id',
        [orderId],
      );
      return {
        orderId: order.id,
        status: order.status,
        totalCents: order.total_cents,
        items: order.items,
        invoiceId: order.erp_invoice_id,
        attempts: order.attempts,
        lastError: order.last_error,
        reservedUntil: order.reserved_until?.toISOString() ?? null,
        createdAt: order.created_at.toISOString(),
        updatedAt: order.updated_at.toISOString(),
        history: events.rows.map((e) => ({
          from: e.from_status,
          to: e.to_status,
          at: e.created_at.toISOString(),
          ...(e.detail ? { detail: e.detail } : {}),
        })),
      };
    },

    cancelReserved: (orderId, reason) =>
      withTx(db, async (tx): Promise<CancelResult> => {
        // Same row lock as the worker's startAttempt: either the cancel commits first and the worker then sees a
        // terminal order (and never calls the ERP), or the worker moved it to INVOICING and the cancel is refused.
        const { rows } = await tx.query<{ status: OrderStatus; items: Array<{ sku: string; quantity: number }> }>(
          'SELECT status, items FROM orders WHERE id = $1 FOR UPDATE',
          [orderId],
        );
        const order = rows[0];
        if (!order) return { kind: 'not_found' };
        if (order.status === 'CANCELLED') return { kind: 'already_cancelled' };
        if (order.status !== 'RESERVED') return { kind: 'not_cancellable', status: order.status };
        // Mirrors invoicing's releaseReservation (a module never imports another module's repository). Sorted SKU
        // order keeps the lock order of checkout, so a cancel and a reservation cannot deadlock.
        for (const item of [...order.items].sort((a, b) => a.sku.localeCompare(b.sku))) {
          await tx.query(
            `UPDATE inventory SET available = available + $2, reserved = reserved - $2, updated_at = now()
             WHERE sku = $1 AND reserved >= $2`,
            [item.sku, item.quantity],
          );
        }
        await tx.query(
          `UPDATE orders SET status = 'CANCELLED', last_error = $2, updated_at = now(), invoicing_lease_until = NULL
           WHERE id = $1`,
          [orderId, reason],
        );
        await tx.query(
          `INSERT INTO order_events (order_id, from_status, to_status, detail) VALUES ($1, 'RESERVED', 'CANCELLED', $2)`,
          [orderId, JSON.stringify({ reason, released: true })],
        );
        return { kind: 'cancelled' };
      }),
  };
}
