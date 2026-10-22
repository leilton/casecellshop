// PLACEHOLDER — exposes /metrics and measures queue/DLQ depth only to prove connectivity.
// Replace with the real worker: consume checkout-orders → call ERP /invoices → update the order;
// a permanent failure lands in the DLQ (SQS redrive) and releases the stock reservation.
import '../observability/tracing';
import http from 'node:http';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import pino from 'pino';
import client from 'prom-client';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'casecellshop-worker' } });
const sqs = new SQSClient({ endpoint: process.env.SQS_ENDPOINT });
client.collectDefaultMetrics({ prefix: 'casecellshop_worker_' });

http
  .createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('content-type', client.register.contentType);
      return res.end(await client.register.metrics());
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(Number(process.env.METRICS_PORT ?? 9464));

log.info('worker placeholder started');

// Does not consume messages (otherwise they would hit the DLQ unprocessed); only measures depth.
const queueDepth = new client.Gauge({
  name: 'checkout_queue_depth',
  help: 'Visible messages in the queue',
  labelNames: ['queue'],
});

async function pollQueueDepth() {
  for (;;) {
    for (const [queue, url] of [
      ['main', process.env.CHECKOUT_QUEUE_URL],
      ['dlq', process.env.CHECKOUT_DLQ_URL],
    ] as const) {
      try {
        const out = await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }),
        );
        queueDepth.set({ queue }, Number(out.Attributes?.ApproximateNumberOfMessages ?? 0));
      } catch (err) {
        log.error({ err, queue }, 'failed to read queue attributes');
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

void pollQueueDepth();
