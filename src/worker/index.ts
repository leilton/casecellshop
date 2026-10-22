// Tracing MUST be the first import: it patches http/pg/aws-sdk before they load.
import '../observability/tracing';
import http from 'node:http';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createCatalogRepository } from '../modules/catalog/repository';
import { createCatalogService } from '../modules/catalog/service';
import { createCatalogSync } from '../modules/catalog/sync';
import { createInvoicingRepository } from '../modules/invoicing/repository';
import { createInvoicingService } from '../modules/invoicing/service';
import { createOutboxRelay } from '../modules/outbox/relay';
import { createOutboxRepository } from '../modules/outbox/repository';
import { createRedisCacheStore } from '../shared/cache-store';
import { config } from '../shared/config';
import { createDb } from '../shared/db';
import { createHttpErpClient } from '../shared/erp';
import { createLogger } from '../shared/logger';
import { checkoutQueueDepth, collectDefaultMetrics, inventoryAvailable, registry } from '../shared/metrics';
import { createRedis } from '../shared/redis';
import { createSqs } from '../shared/sqs';
import { createQueueConsumer } from './consumer';
import { runLoop } from './loop';

const GAUGE_INTERVAL_MS = 5000;
const CONSUMER_IDLE_MS = 100;

async function main() {
  const cfg = config();
  const logger = createLogger('casecellshop-worker', cfg.LOG_LEVEL);
  collectDefaultMetrics('casecellshop_worker_');

  const db = createDb(cfg.DATABASE_URL);
  const redis = createRedis(cfg.REDIS_URL);
  const sqs = createSqs(cfg);
  const erp = createHttpErpClient({ baseUrl: cfg.ERP_BASE_URL, timeoutMs: cfg.ERP_TIMEOUT_MS });

  const catalogRepo = createCatalogRepository(db);
  const catalog = createCatalogService({
    erp,
    repo: catalogRepo,
    store: createRedisCacheStore(redis),
    logger,
    ttl: {
      priceS: cfg.CACHE_TTL_PRICE_S,
      stockS: cfg.CACHE_TTL_STOCK_S,
      staleIfErrorS: cfg.CACHE_STALE_IF_ERROR_S,
      lockMs: cfg.CACHE_LOCK_TTL_MS,
    },
  });
  const sync = createCatalogSync({ erp, repo: catalogRepo, catalog, logger });
  const invoicing = createInvoicingService({
    repo: createInvoicingRepository(db),
    erp,
    logger,
    backoff: { baseS: cfg.WORKER_BACKOFF_BASE_S, maxS: cfg.WORKER_BACKOFF_MAX_S, maxAttempts: cfg.WORKER_MAX_ATTEMPTS },
    stuckInvoicingAfterS: cfg.INVOICING_STUCK_AFTER_S,
    leaseS: cfg.INVOICING_LEASE_S,
  });
  const relay = createOutboxRelay({
    repo: createOutboxRepository(db),
    sqs,
    queueUrl: cfg.CHECKOUT_QUEUE_URL,
    batchSize: cfg.OUTBOX_BATCH_SIZE,
    logger,
  });
  const mainConsumer = createQueueConsumer({
    name: 'checkout-orders',
    sqs,
    queueUrl: cfg.CHECKOUT_QUEUE_URL,
    concurrency: cfg.WORKER_CONCURRENCY,
    handle: (orderId) => invoicing.processOrder(orderId),
    logger,
  });
  const dlqConsumer = createQueueConsumer({
    name: 'checkout-orders-dlq',
    sqs,
    queueUrl: cfg.CHECKOUT_DLQ_URL,
    concurrency: 1,
    handle: (orderId) => invoicing.handleDeadLetter(orderId),
    logger,
  });

  async function refreshGauges() {
    for (const [queue, url] of [
      ['main', cfg.CHECKOUT_QUEUE_URL],
      ['dlq', cfg.CHECKOUT_DLQ_URL],
    ] as const) {
      const out = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }),
      );
      checkoutQueueDepth.set({ queue }, Number(out.Attributes?.ApproximateNumberOfMessages ?? 0));
    }
    for (const [sku, available] of Object.entries(await catalogRepo.listAvailability())) {
      inventoryAvailable.set({ sku }, available);
    }
    return 0;
  }

  const metricsServer = http
    .createServer((req, res) => {
      if (req.url === '/metrics') {
        registry.metrics().then(
          (body) => {
            res.setHeader('content-type', registry.contentType);
            res.end(body);
          },
          () => {
            res.statusCode = 500;
            res.end();
          },
        );
        return;
      }
      res.statusCode = req.url === '/health' ? 200 : 404;
      res.end();
    })
    .listen(cfg.METRICS_PORT);

  const controller = new AbortController();
  const { signal } = controller;
  const loops = [
    runLoop('outbox-relay', () => relay.runOnce(), { intervalMs: cfg.OUTBOX_POLL_INTERVAL_MS, signal, logger }),
    ...Array.from({ length: Math.max(1, Math.ceil(cfg.WORKER_CONCURRENCY / 10)) }, () =>
      runLoop('consumer-main', () => mainConsumer.pollOnce(), { intervalMs: CONSUMER_IDLE_MS, signal, logger }),
    ),
    runLoop('consumer-dlq', () => dlqConsumer.pollOnce(), { intervalMs: CONSUMER_IDLE_MS, signal, logger }),
    runLoop('reconciler', async () => void (await invoicing.reconcile()), {
      intervalMs: cfg.RECONCILE_INTERVAL_MS,
      signal,
      logger,
    }),
    runLoop('catalog-sync', async () => void (await sync.runOnce()), {
      intervalMs: cfg.CATALOG_SYNC_INTERVAL_MS,
      signal,
      logger,
    }),
    runLoop('gauges', refreshGauges, { intervalMs: GAUGE_INTERVAL_MS, signal, logger }),
  ];
  logger.info({ concurrency: cfg.WORKER_CONCURRENCY }, 'worker started');

  const shutdown = async (sig: string) => {
    logger.info({ signal: sig }, 'shutting down, finishing in-flight messages');
    controller.abort();
    // In-flight long polls end within WaitTimeSeconds; unfinished messages simply become visible again.
    await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 25_000))]);
    metricsServer.close();
    await Promise.allSettled([db.end(), redis.quit()]);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`worker failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
