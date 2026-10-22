// Tracing MUST be the first import: it patches http/fastify/pg/ioredis/aws-sdk before they load.
import '../observability/tracing';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createCatalogRepository } from '../modules/catalog/repository';
import { createCatalogService } from '../modules/catalog/service';
import { createCheckoutRepository } from '../modules/checkout/repository';
import { createCheckoutService } from '../modules/checkout/service';
import { createOrdersRepository } from '../modules/orders/repository';
import { createOrdersService } from '../modules/orders/service';
import { createRedisCacheStore } from '../shared/cache-store';
import { config } from '../shared/config';
import { createDb } from '../shared/db';
import { createHttpErpClient } from '../shared/erp';
import { createLogger } from '../shared/logger';
import { collectDefaultMetrics } from '../shared/metrics';
import { createRedis } from '../shared/redis';
import { createSqs } from '../shared/sqs';
import { buildApp, type DependencyStatus } from './app';

async function main() {
  const cfg = config();
  const logger = createLogger('casecellshop-api', cfg.LOG_LEVEL);
  collectDefaultMetrics('casecellshop_api_');

  const db = createDb(cfg.DATABASE_URL);
  const redis = createRedis(cfg.REDIS_URL);
  const sqs = createSqs(cfg);
  const erp = createHttpErpClient({ baseUrl: cfg.ERP_BASE_URL, timeoutMs: cfg.ERP_TIMEOUT_MS });

  const catalog = createCatalogService({
    erp,
    repo: createCatalogRepository(db),
    store: createRedisCacheStore(redis),
    logger,
    ttl: {
      priceS: cfg.CACHE_TTL_PRICE_S,
      stockS: cfg.CACHE_TTL_STOCK_S,
      staleIfErrorS: cfg.CACHE_STALE_IF_ERROR_S,
      lockMs: cfg.CACHE_LOCK_TTL_MS,
    },
  });
  const checkout = createCheckoutService({
    repo: createCheckoutRepository(db),
    catalog,
    logger,
    reservationTtlS: cfg.RESERVATION_TTL_S,
  });
  const orders = createOrdersService({ repo: createOrdersRepository(db) });

  async function check(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return 'ok';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  const health = async (): Promise<DependencyStatus> => {
    const [postgres, redisStatus, queue, erpStatus] = await Promise.all([
      check(() => db.query('SELECT 1')),
      check(() => redis.ping()),
      check(() => sqs.send(new GetQueueAttributesCommand({ QueueUrl: cfg.CHECKOUT_QUEUE_URL }))),
      check(async () => {
        const res = await fetch(`${cfg.ERP_BASE_URL}/health`, { signal: AbortSignal.timeout(cfg.ERP_TIMEOUT_MS) });
        // Always drain the body: an unread undici response keeps its keep-alive socket busy, and the next ERP
        // call to the same origin can hang on it until its own timeout (seen as intermittent 2s 503s).
        await res.arrayBuffer();
        if (!res.ok) throw new Error(`status ${res.status}`);
      }),
    ]);
    return { postgres, redis: redisStatus, sqs: queue, erp: erpStatus };
  };

  const app = await buildApp({
    logger,
    catalog,
    checkout,
    orders,
    health,
    trustProxy: cfg.TRUST_PROXY,
    rateLimitRedis: redis,
    rateLimitNamespace: 'rl:',
    checkoutLimits: {
      max: cfg.CHECKOUT_MAX_CONCURRENCY,
      maxQueue: cfg.CHECKOUT_MAX_QUEUE,
      queueTimeoutMs: cfg.CHECKOUT_QUEUE_TIMEOUT_MS,
      rateLimit: { max: cfg.CHECKOUT_RATE_LIMIT_MAX, windowS: cfg.CHECKOUT_RATE_LIMIT_WINDOW_S },
    },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await Promise.allSettled([db.end(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: cfg.PORT });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid config), so write the failure directly to stderr.
  process.stderr.write(`api failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
