import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInvoicingRepository } from '../../src/modules/invoicing/repository';
import { createInvoicingService } from '../../src/modules/invoicing/service';
import { createOutboxRelay } from '../../src/modules/outbox/relay';
import { createOutboxRepository } from '../../src/modules/outbox/repository';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { createSqs } from '../../src/shared/sqs';
import { createQueueConsumer } from '../../src/worker/consumer';
import { createServices, createTestRedis, type TestServices } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { requireEnv, uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';
import { silentLogger } from '../support/fakes';

let db: Db;
let redis: RedisClient;
let sqs: SQSClient;
let fx: Fixtures;
let services: TestServices;
const queues: string[] = [];

beforeAll(() => {
  db = createTestDb();
  redis = createTestRedis();
  sqs = createSqs({ AWS_REGION: 'us-east-1', SQS_ENDPOINT: requireEnv('SQS_ENDPOINT') });
  fx = new Fixtures(db);
  services = createServices(db, redis, new FakeErp());
});
afterEach(() => fx.cleanup());
afterAll(async () => {
  await Promise.all(queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)));
  await db.end();
  await redis.quit();
});

async function createQueue(): Promise<string> {
  const out = await sqs.send(new CreateQueueCommand({ QueueName: uniqueId('test-checkout').toLowerCase() }));
  if (!out.QueueUrl) throw new Error('queue not created');
  queues.push(out.QueueUrl);
  return out.QueueUrl;
}

async function queueDepth(url: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(out.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}

async function placeOrders(n: number) {
  const sku = await fx.sku({ available: 100 });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = uniqueId('ob');
    const { accepted } = await services.checkout.place({
      idempotencyKey: key,
      items: [{ sku, quantity: 1 }],
      correlationId: key,
    });
    ids.push(accepted.orderId);
  }
  return { sku, ids };
}

async function unpublished(ids: string[]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM outbox WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NULL',
    [ids],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The relay publishes every pending row in the DB; drain until the rows of this test are out. */
async function drain(relay: ReturnType<typeof createOutboxRelay>, ids: string[]) {
  for (let i = 0; i < 50 && (await unpublished(ids)) > 0; i++) await relay.runOnce();
}

describe('outbox relay → SQS → consumer (real queue)', () => {
  it('publishes each outbox row once and marks it as published', async () => {
    const queueUrl = await createQueue();
    const { ids } = await placeOrders(3);
    const relay = createOutboxRelay({
      repo: createOutboxRepository(db),
      sqs,
      queueUrl,
      batchSize: 10,
      logger: silentLogger,
    });

    await drain(relay, ids);

    expect(await unpublished(ids)).toBe(0);
    expect(await queueDepth(queueUrl)).toBeGreaterThanOrEqual(3);
  });

  it('two relays running in parallel never publish the same row twice (SKIP LOCKED)', async () => {
    const queueUrl = await createQueue();
    const { ids } = await placeOrders(12);
    const make = () =>
      createOutboxRelay({ repo: createOutboxRepository(db), sqs, queueUrl, batchSize: 5, logger: silentLogger });
    const [r1, r2] = [make(), make()];

    for (let i = 0; i < 20 && (await unpublished(ids)) > 0; i++) await Promise.all([r1.runOnce(), r2.runOnce()]);

    expect(await unpublished(ids)).toBe(0);
    const consumed = new Map<string, number>();
    const consumer = createQueueConsumer({
      name: 'count',
      sqs,
      queueUrl,
      concurrency: 10,
      waitTimeS: 1,
      handle: async (orderId) => {
        consumed.set(orderId, (consumed.get(orderId) ?? 0) + 1);
        return { action: 'ack', reason: 'counted' };
      },
      logger: silentLogger,
    });
    while ((await consumer.pollOnce()) > 0) {
      // drain
    }
    for (const id of ids) expect(consumed.get(id)).toBe(1);
  });

  it('end to end: checkout → relay → consumer → ERP leaves every order INVOICED with one invoice', async () => {
    const queueUrl = await createQueue();
    const erp = new FakeErp()
      .failNext('createInvoice', 'timeout-after-create')
      .failNext('createInvoice', 'unavailable');
    const invoicing = createInvoicingService({
      repo: createInvoicingRepository(db),
      erp,
      logger: silentLogger,
      backoff: { baseS: 1, maxS: 1, maxAttempts: 5 },
      stuckInvoicingAfterS: 120,
      leaseS: 15,
    });
    const { sku, ids } = await placeOrders(4);
    const relay = createOutboxRelay({
      repo: createOutboxRepository(db),
      sqs,
      queueUrl,
      batchSize: 10,
      logger: silentLogger,
    });
    const consumer = createQueueConsumer({
      name: 'e2e',
      sqs,
      queueUrl,
      concurrency: 10,
      waitTimeS: 1,
      handle: (orderId) => invoicing.processOrder(orderId),
      logger: silentLogger,
    });

    await drain(relay, ids);
    const deadline = Date.now() + 15_000;
    const done = async () => {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM orders WHERE id = ANY($1::uuid[]) AND status = 'INVOICED'`,
        [ids],
      );
      return Number(rows[0]?.n) === ids.length;
    };
    while (!(await done()) && Date.now() < deadline) await consumer.pollOnce();

    expect(await done()).toBe(true);
    for (const id of ids) expect(erp.invoicesFor(id)).toHaveLength(1);
    expect(await fx.inventory(sku)).toEqual({ available: 96, reserved: 0 });
  });
});
