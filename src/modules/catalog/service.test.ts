import { describe, expect, it, vi } from 'vitest';
import { FakeErp } from '../../../tests/support/fake-erp';
import { connectionRefused, MemoryCacheStore, silentLogger } from '../../../tests/support/fakes';
import { AppError } from '../../shared/errors';
import type { CatalogRepository } from './repository';
import { createCatalogService, worstCacheResult } from './service';
import { createCatalogSync } from './sync';

function fakeRepo(overrides: Partial<CatalogRepository> = {}): CatalogRepository {
  return {
    listAvailability: vi.fn(async () => ({ 'CASE-A': 3, 'CASE-B': 0 })),
    listVersions: vi.fn(async () => ({ 'CASE-A': 1, 'CASE-B': 1 })),
    upsertProducts: vi.fn(async () => undefined),
    findPriced: vi.fn(async () => []),
    ...overrides,
  };
}

function setup(repo = fakeRepo(), erp = new FakeErp([{ sku: 'CASE-A', priceCents: 4990 }, { sku: 'CASE-B' }])) {
  const store = new MemoryCacheStore();
  const service = createCatalogService({
    erp,
    repo,
    store,
    logger: silentLogger,
    ttl: { priceS: 60, stockS: 5, staleIfErrorS: 120, lockMs: 1000 },
    keyPrefix: `unit-${Math.random()}:`,
  });
  return { service, erp, repo, store };
}

describe('catalog service', () => {
  it('merges ERP names/prices with our own availability', async () => {
    const { service } = setup();

    const list = await service.list();

    expect(list.items).toEqual([
      { sku: 'CASE-A', name: 'CASE-A', priceCents: 4990, version: 1, available: 3, inStock: true },
      { sku: 'CASE-B', name: 'CASE-B', priceCents: 1000, version: 1, available: 0, inStock: false },
    ]);
    expect(list.meta).toMatchObject({ stale: false, cache: { products: 'miss', stock: 'miss' } });
  });

  it('treats a SKU missing from inventory as unavailable', async () => {
    const { service } = setup(fakeRepo({ listAvailability: vi.fn(async () => ({})) }));

    const list = await service.list();

    expect(list.items.every((i) => i.available === 0 && !i.inStock)).toBe(true);
  });

  it('filters by sku and returns 404 for an unknown one', async () => {
    const { service } = setup();

    expect((await service.list({ sku: 'CASE-B' })).items.map((i) => i.sku)).toEqual(['CASE-B']);
    await expect(service.list({ sku: 'CASE-NOPE' })).rejects.toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('serves from cache: a second list does not call the ERP', async () => {
    const { service, erp } = setup();
    await service.list();
    const second = await service.list();

    expect(erp.calls.listProducts).toBe(1);
    expect(second.meta.cache.products).toBe('hit');
  });

  it('answers 503 CATALOG_UNAVAILABLE when the ERP fails and nothing is cached', async () => {
    const erp = new FakeErp([{ sku: 'CASE-A' }]).failAlways('listProducts', 'timeout');
    const { service } = setup(fakeRepo(), erp);

    await expect(service.list()).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE', httpStatus: 503 });
  });

  it('answers 503 DEPENDENCY_UNAVAILABLE when inventory cannot be read', async () => {
    const { service } = setup(fakeRepo({ listAvailability: vi.fn(async () => Promise.reject(connectionRefused())) }));

    await expect(service.list()).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', httpStatus: 503 });
  });

  it('lets unexpected errors through (they become 500 at the edge)', async () => {
    const { service } = setup(fakeRepo({ listAvailability: vi.fn(async () => Promise.reject(new TypeError('bug'))) }));

    const err = await service.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('picks the worst cache result for the x-cache header', () => {
    expect(worstCacheResult('hit', 'hit')).toBe('hit');
    expect(worstCacheResult('hit', 'miss')).toBe('miss');
    expect(worstCacheResult('miss', 'stale')).toBe('stale');
  });
});

describe('catalog sync', () => {
  it('updates the read model and evicts the cache only for SKUs whose ERP version moved', async () => {
    const erp = new FakeErp([{ sku: 'CASE-A' }, { sku: 'CASE-B' }]);
    erp.setProduct('CASE-A', { priceCents: 5990 });
    const repo = fakeRepo();
    const invalidateProducts = vi.fn(async () => undefined);
    const sync = createCatalogSync({ erp, repo, catalog: { invalidateProducts }, logger: silentLogger });

    expect(await sync.runOnce()).toEqual(['CASE-A']);
    expect(repo.upsertProducts).toHaveBeenCalledWith([{ sku: 'CASE-A', name: 'CASE-A', priceCents: 5990, version: 2 }]);
    expect(invalidateProducts).toHaveBeenCalledTimes(1);
  });

  it('does nothing when versions did not change', async () => {
    const repo = fakeRepo();
    const invalidateProducts = vi.fn(async () => undefined);
    const sync = createCatalogSync({
      erp: new FakeErp([{ sku: 'CASE-A' }, { sku: 'CASE-B' }]),
      repo,
      catalog: { invalidateProducts },
      logger: silentLogger,
    });

    expect(await sync.runOnce()).toEqual([]);
    expect(repo.upsertProducts).not.toHaveBeenCalled();
    expect(invalidateProducts).not.toHaveBeenCalled();
  });

  it('adds SKUs that are new in the ERP', async () => {
    const repo = fakeRepo({ listVersions: vi.fn(async () => ({ 'CASE-A': 1 })) });
    const sync = createCatalogSync({
      erp: new FakeErp([{ sku: 'CASE-A' }, { sku: 'CASE-NEW' }]),
      repo,
      catalog: { invalidateProducts: vi.fn(async () => undefined) },
      logger: silentLogger,
    });

    expect(await sync.runOnce()).toEqual(['CASE-NEW']);
  });
});
