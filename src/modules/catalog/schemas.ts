import { z } from 'zod';

export const skuSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,63}$/, 'sku must be 1-64 uppercase letters, digits or dashes');

export const listProductsQuerySchema = z.object({ sku: skuSchema.optional() }).strict();
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productSchema = z.object({
  sku: z.string(),
  name: z.string(),
  priceCents: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  inStock: z.boolean(),
  version: z.number().int().positive(),
});
export type Product = z.infer<typeof productSchema>;

export const cacheResultSchema = z.enum(['hit', 'miss', 'stale']);

export const productListSchema = z.object({
  items: z.array(productSchema),
  meta: z.object({
    stale: z.boolean(),
    cache: z.object({ products: cacheResultSchema, stock: cacheResultSchema }),
    productsAgeS: z.number().int().nonnegative(),
    stockAgeS: z.number().int().nonnegative(),
  }),
});
export type ProductList = z.infer<typeof productListSchema>;

/** Snapshot of the ERP catalog stored in the cache (names and prices change together in the ERP payload). */
export interface CatalogEntry {
  sku: string;
  name: string;
  priceCents: number;
  version: number;
}

export interface PricedProduct {
  sku: string;
  name: string;
  priceCents: number;
}
