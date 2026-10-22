import type { FastifyPluginAsync } from 'fastify';
import { parseOrThrow } from '../../api/validation';
import { listProductsQuerySchema } from './schemas';
import { type CatalogService, worstCacheResult } from './service';

export const catalogRoutes: FastifyPluginAsync<{ service: CatalogService }> = async (app, { service }) => {
  app.get('/products', async (req, reply) => {
    const query = parseOrThrow(listProductsQuerySchema, req.query);
    const list = await service.list(query);
    reply.header('x-cache', worstCacheResult(list.meta.cache.products, list.meta.cache.stock));
    // Browsers/CDN may reuse a fresh page briefly (stock TTL is the binding constraint); a stale page is a
    // fallback that must not be cached further downstream.
    reply.header('cache-control', list.meta.stale ? 'no-store' : 'public, max-age=5');
    return list;
  });
};
