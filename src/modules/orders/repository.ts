import type { Queryable } from '../../shared/db';
import type { OrderStatus } from '../checkout/schemas';
import type { OrderStatusResponse } from './schemas';

export interface OrdersRepository {
  findStatus(orderId: string): Promise<OrderStatusResponse | undefined>;
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

export function createOrdersRepository(db: Queryable): OrdersRepository {
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
  };
}
