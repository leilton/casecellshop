// PLACEHOLDER — only proves the environment starts and can reach its dependencies.
// Replace with the challenge endpoints: GET /products, POST /checkout, GET /orders/:id/status.
// Tracing MUST be the first import: it instruments http/fastify/pg/ioredis/aws-sdk before they load.
import '../observability/tracing';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import Fastify from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import client from 'prom-client';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL!);
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });

client.collectDefaultMetrics({ prefix: 'casecellshop_api_' });

async function check(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    return [name, 'ok'] as const;
  } catch (err) {
    return [name, (err as Error).message] as const;
  }
}

app.get('/health', async (_req, reply) => {
  const results = Object.fromEntries(
    await Promise.all([
      check('postgres', () => db.query('select 1')),
      check('redis', () => redis.ping()),
      check('sqs', () =>
        sqs.send(new GetQueueAttributesCommand({ QueueUrl: process.env.CHECKOUT_QUEUE_URL, AttributeNames: ['All'] })),
      ),
      check('erp', () =>
        fetch(`${process.env.ERP_BASE_URL}/health`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
        }),
      ),
    ]),
  );
  const healthy = Object.values(results).every((v) => v === 'ok');
  return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', deps: results });
});

app.get('/metrics', async (_req, reply) => {
  reply.header('content-type', client.register.contentType);
  return client.register.metrics();
});

app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
