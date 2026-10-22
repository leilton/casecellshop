import type { CacheStore } from '../../shared/cache-store';
import { type ErpClient, ErpError } from '../../shared/erp';
import { AppError, isConnectionError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { CacheResult } from '../../shared/metrics';
import { type CachedLoader, createCachedLoader } from './cache';
import type { CatalogRepository } from './repository';
import type { CatalogEntry, PricedProduct, ProductList } from './schemas';

export const PRODUCTS_CACHE_KEY = 'catalog:v1:products';
export const STOCK_CACHE_KEY = 'catalog:v1:stock';

export interface CatalogServiceDeps {
  erp: ErpClient;
  repo: CatalogRepository;
  store: CacheStore;
  logger: Logger;
  ttl: { priceS: number; stockS: number; staleIfErrorS: number; lockMs: number };
  /** Namespaces cache keys so tests (and future tenants) never share entries. */
  keyPrefix?: string;
}

export interface CatalogService {
  list(filter?: { sku?: string }): Promise<ProductList>;
  /** Server-side prices for checkout: never trust a price sent by the client. */
  priceFor(skus: string[]): Promise<PricedProduct[]>;
  invalidateProducts(): Promise<void>;
  invalidateStock(): Promise<void>;
}

const severity: Record<CacheResult, number> = { hit: 0, miss: 1, stale: 2 };

export function worstCacheResult(...results: CacheResult[]): CacheResult {
  return results.reduce((a, b) => (severity[b] > severity[a] ? b : a), 'hit');
}

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  const prefix = deps.keyPrefix ?? '';

  // Names and prices arrive together from the ERP, so they share one entry whose freshness is bounded by the
  // most volatile field (price). Stock comes from our own inventory and has a much shorter TTL.
  const products: CachedLoader<CatalogEntry[]> = createCachedLoader({
    name: 'products',
    key: `${prefix}${PRODUCTS_CACHE_KEY}`,
    store: deps.store,
    logger: deps.logger,
    freshTtlS: deps.ttl.priceS,
    staleTtlS: deps.ttl.staleIfErrorS,
    lockTtlMs: deps.ttl.lockMs,
    load: async () =>
      (await deps.erp.listProducts()).map((p) => ({
        sku: p.sku,
        name: p.name,
        priceCents: p.priceCents,
        version: p.version,
      })),
  });

  const stock: CachedLoader<Record<string, number>> = createCachedLoader({
    name: 'stock',
    key: `${prefix}${STOCK_CACHE_KEY}`,
    store: deps.store,
    logger: deps.logger,
    freshTtlS: deps.ttl.stockS,
    staleTtlS: deps.ttl.staleIfErrorS,
    lockTtlMs: deps.ttl.lockMs,
    load: () => deps.repo.listAvailability(),
  });

  async function loadProducts() {
    try {
      return await products.get();
    } catch (err) {
      if (err instanceof ErpError) {
        deps.logger.warn({ kind: err.kind, status: err.status }, 'ERP catalog failed and no stale value to serve');
        throw new AppError('CATALOG_UNAVAILABLE', 503, 'Catalog is temporarily unavailable, try again shortly');
      }
      throw err;
    }
  }

  async function loadStock() {
    try {
      return await stock.get();
    } catch (err) {
      if (isConnectionError(err)) {
        throw new AppError('DEPENDENCY_UNAVAILABLE', 503, 'Inventory is temporarily unavailable');
      }
      throw err;
    }
  }

  return {
    async list(filter) {
      const [p, s] = await Promise.all([loadProducts(), loadStock()]);
      let entries = p.value;
      if (filter?.sku) {
        entries = entries.filter((e) => e.sku === filter.sku);
        if (entries.length === 0) throw new AppError('PRODUCT_NOT_FOUND', 404, `Product ${filter.sku} not found`);
      }
      const items = entries.map((e) => {
        const available = s.value[e.sku] ?? 0;
        return {
          sku: e.sku,
          name: e.name,
          priceCents: e.priceCents,
          version: e.version,
          available,
          inStock: available > 0,
        };
      });
      return {
        items,
        meta: {
          stale: p.result === 'stale' || s.result === 'stale',
          cache: { products: p.result, stock: s.result },
          productsAgeS: p.ageS,
          stockAgeS: s.ageS,
        },
      };
    },

    priceFor: (skus) => deps.repo.findPriced(skus),
    invalidateProducts: () => products.invalidate(),
    invalidateStock: () => stock.invalidate(),
  };
}
