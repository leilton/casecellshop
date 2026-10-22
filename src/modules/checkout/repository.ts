import { type Db, withTx } from '../../shared/db';
import type { OrderPlacedMessage, OrderStatus, StockShortage } from './schemas';

export interface PricedItem {
  sku: string;
  quantity: number;
  priceCents: number;
}

export interface PlaceOrderInput {
  idempotencyKey: string;
  requestHash: string;
  items: PricedItem[];
  totalCents: number;
  correlationId: string;
  reservationTtlS: number;
  message: Omit<OrderPlacedMessage, 'orderId'>;
}

export type PlaceOrderResult =
  | { kind: 'created'; orderId: string; status: OrderStatus }
  | { kind: 'existing'; orderId: string; status: OrderStatus; requestHash: string }
  | { kind: 'out_of_stock'; items: StockShortage[] };

export interface CheckoutRepository {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
}

class OutOfStock extends Error {
  constructor(readonly items: StockShortage[]) {
    super('out of stock');
  }
}

export function createCheckoutRepository(db: Db): CheckoutRepository {
  return {
    async placeOrder(input) {
      try {
        return await withTx(db, async (tx) => {
          // The UNIQUE index serialises a double click: the second INSERT waits for the first transaction and
          // then either sees its committed row (DO NOTHING) or, if it rolled back, proceeds as a fresh order.
          const inserted = await tx.query<{ id: string; status: OrderStatus }>(
            `INSERT INTO orders (idempotency_key, request_hash, status, items, total_cents, correlation_id, reserved_until)
             VALUES ($1, $2, 'RESERVED', $3, $4, $5, now() + make_interval(secs => $6))
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING id, status`,
            [
              input.idempotencyKey,
              input.requestHash,
              JSON.stringify(input.items),
              input.totalCents,
              input.correlationId,
              input.reservationTtlS,
            ],
          );
          const created = inserted.rows[0];
          if (!created) {
            const { rows } = await tx.query<{ id: string; status: OrderStatus; request_hash: string }>(
              'SELECT id, status, request_hash FROM orders WHERE idempotency_key = $1',
              [input.idempotencyKey],
            );
            const existing = rows[0];
            if (!existing) throw new Error('idempotency conflict without a visible order');
            return {
              kind: 'existing',
              orderId: existing.id,
              status: existing.status,
              requestHash: existing.request_hash,
            };
          }

          // Sorted SKU order gives every transaction the same lock order, so crossed carts cannot deadlock.
          const missing: StockShortage[] = [];
          for (const item of [...input.items].sort((a, b) => a.sku.localeCompare(b.sku))) {
            const res = await tx.query(
              `UPDATE inventory SET available = available - $2, reserved = reserved + $2, updated_at = now()
               WHERE sku = $1 AND available >= $2 RETURNING available`,
              [item.sku, item.quantity],
            );
            if (res.rowCount === 0) {
              // Failure path only, and this transaction never touched this SKU, so the read is a plain snapshot
              // of what is left. Advisory, like the storefront stock: the next reservation is still the real check.
              const left = await tx.query<{ available: number }>('SELECT available FROM inventory WHERE sku = $1', [
                item.sku,
              ]);
              missing.push({ sku: item.sku, requested: item.quantity, available: left.rows[0]?.available ?? 0 });
            }
          }
          if (missing.length > 0) throw new OutOfStock(missing);

          await tx.query(
            `INSERT INTO order_events (order_id, from_status, to_status, detail) VALUES ($1, NULL, 'RESERVED', $2)`,
            [created.id, JSON.stringify({ items: input.items.map(({ sku, quantity }) => ({ sku, quantity })) })],
          );
          await tx.query(`INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'OrderPlaced', $2)`, [
            created.id,
            JSON.stringify({ ...input.message, orderId: created.id }),
          ]);
          return { kind: 'created', orderId: created.id, status: created.status };
        });
      } catch (err) {
        if (err instanceof OutOfStock) return { kind: 'out_of_stock', items: err.items };
        throw err;
      }
    },
  };
}
