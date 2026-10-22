import { createDb, type Db } from '../../src/shared/db';
import { testDatabaseUrl, uniqueId } from './env';

export function createTestDb(): Db {
  return createDb(testDatabaseUrl());
}

/** Creates SKUs with their own stock and remembers every row it touches, so `cleanup()` can remove them. */
export class Fixtures {
  private readonly skus: string[] = [];

  constructor(readonly db: Db) {}

  async sku(opts: { available: number; priceCents?: number; name?: string; version?: number }): Promise<string> {
    const sku = uniqueId('T');
    this.skus.push(sku);
    await this.db.query('INSERT INTO products (sku, name, price_cents, version) VALUES ($1, $2, $3, $4)', [
      sku,
      opts.name ?? `Test ${sku}`,
      opts.priceCents ?? 1000,
      opts.version ?? 1,
    ]);
    await this.db.query('INSERT INTO inventory (sku, available) VALUES ($1, $2)', [sku, opts.available]);
    return sku;
  }

  /** Tracks a SKU created by the code under test (e.g. catalog sync) for cleanup. */
  track(sku: string): void {
    this.skus.push(sku);
  }

  async inventory(sku: string): Promise<{ available: number; reserved: number }> {
    const { rows } = await this.db.query<{ available: number; reserved: number }>(
      'SELECT available, reserved FROM inventory WHERE sku = $1',
      [sku],
    );
    const row = rows[0];
    if (!row) throw new Error(`no inventory for ${sku}`);
    return row;
  }

  async order(orderId: string) {
    const { rows } = await this.db.query<{
      status: string;
      attempts: number;
      erp_invoice_id: string | null;
      last_error: string | null;
    }>('SELECT status, attempts, erp_invoice_id, last_error FROM orders WHERE id = $1', [orderId]);
    return rows[0];
  }

  async count(table: 'outbox' | 'order_events', orderId: string): Promise<number> {
    const column = table === 'outbox' ? 'aggregate_id' : 'order_id';
    const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, [
      orderId,
    ]);
    return Number(rows[0]?.n ?? 0);
  }

  async cleanup(): Promise<void> {
    if (this.skus.length === 0) return;
    const orders = `SELECT id FROM orders WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(items) AS i WHERE i->>'sku' = ANY($1::text[]))`;
    await this.db.query(`DELETE FROM order_events WHERE order_id IN (${orders})`, [this.skus]);
    await this.db.query(`DELETE FROM outbox WHERE aggregate_id IN (${orders})`, [this.skus]);
    await this.db.query(`DELETE FROM orders WHERE id IN (${orders})`, [this.skus]);
    await this.db.query('DELETE FROM inventory WHERE sku = ANY($1::text[])', [this.skus]);
    await this.db.query('DELETE FROM products WHERE sku = ANY($1::text[])', [this.skus]);
    this.skus.length = 0;
  }
}
