import type { Queryable } from '../../shared/db';
import type { CatalogEntry, PricedProduct } from './schemas';

export interface CatalogRepository {
  /** Sellable units per SKU — the shop's own inventory, the same rows the checkout reserves against. */
  listAvailability(): Promise<Record<string, number>>;
  listVersions(): Promise<Record<string, number>>;
  upsertProducts(products: CatalogEntry[]): Promise<void>;
  findPriced(skus: string[]): Promise<PricedProduct[]>;
}

export function createCatalogRepository(db: Queryable): CatalogRepository {
  return {
    async listAvailability() {
      const { rows } = await db.query<{ sku: string; available: number }>('SELECT sku, available FROM inventory');
      return Object.fromEntries(rows.map((r) => [r.sku, r.available]));
    },

    async listVersions() {
      const { rows } = await db.query<{ sku: string; version: number }>('SELECT sku, version FROM products');
      return Object.fromEntries(rows.map((r) => [r.sku, r.version]));
    },

    async upsertProducts(products) {
      if (products.length === 0) return;
      await db.query(
        `INSERT INTO products (sku, name, price_cents, version, synced_at)
         SELECT * , now() FROM unnest($1::text[], $2::text[], $3::int[], $4::int[])
         ON CONFLICT (sku) DO UPDATE
           SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
               version = EXCLUDED.version, synced_at = now()
         WHERE products.version < EXCLUDED.version`,
        [
          products.map((p) => p.sku),
          products.map((p) => p.name),
          products.map((p) => p.priceCents),
          products.map((p) => p.version),
        ],
      );
      // New SKUs start with no sellable stock until inventory is loaded explicitly.
      await db.query(
        `INSERT INTO inventory (sku, available) SELECT unnest($1::text[]), 0 ON CONFLICT (sku) DO NOTHING`,
        [products.map((p) => p.sku)],
      );
    },

    async findPriced(skus) {
      const { rows } = await db.query<{ sku: string; name: string; price_cents: number }>(
        'SELECT sku, name, price_cents FROM products WHERE sku = ANY($1::text[])',
        [skus],
      );
      return rows.map((r) => ({ sku: r.sku, name: r.name, priceCents: r.price_cents }));
    },
  };
}
