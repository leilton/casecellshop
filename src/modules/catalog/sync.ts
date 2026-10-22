import type { ErpClient } from '../../shared/erp';
import type { Logger } from '../../shared/logger';
import type { CatalogRepository } from './repository';
import type { CatalogService } from './service';

export interface CatalogSync {
  /** Returns the SKUs whose ERP version moved since the last sync. */
  runOnce(): Promise<string[]>;
}

/**
 * The ERP cannot push changes (we may not touch it), so we poll its catalog and compare `version` against
 * our read model. A changed version updates the read model (used for checkout prices) and evicts the
 * storefront cache, so a price change is visible after at most one sync interval instead of a full TTL.
 */
export function createCatalogSync(deps: {
  erp: ErpClient;
  repo: CatalogRepository;
  catalog: Pick<CatalogService, 'invalidateProducts'>;
  logger: Logger;
}): CatalogSync {
  return {
    async runOnce() {
      const [remote, local] = await Promise.all([deps.erp.listProducts(), deps.repo.listVersions()]);
      const changed = remote.filter((p) => local[p.sku] === undefined || p.version > (local[p.sku] ?? 0));
      if (changed.length === 0) return [];
      await deps.repo.upsertProducts(
        changed.map((p) => ({ sku: p.sku, name: p.name, priceCents: p.priceCents, version: p.version })),
      );
      await deps.catalog.invalidateProducts();
      deps.logger.info({ skus: changed.map((p) => p.sku) }, 'catalog changed in ERP, read model updated');
      return changed.map((p) => p.sku);
    },
  };
}
