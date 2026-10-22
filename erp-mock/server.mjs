// Simulated ERP (no dependencies). Reproduces the pain points of the case:
//  - high, variable latency on every call
//  - random 5xx errors and "timeouts" (a response that never arrives in time)
//  - slow, NON-idempotent invoicing (a naive retry creates a duplicate invoice → motivates idempotency/reconciliation)
//
// Endpoints:
//   GET  /health
//   GET  /products                       catalog with price and stock
//   GET  /products/:sku
//   POST /invoices   {orderId, items}    invoices the order (slow)
//   GET  /invoices?orderId=...           lookup for reconciliation
//   GET  /admin/config | POST /admin/config  {latencyMs, jitterMs, errorRate, timeoutRate, invoiceLatencyMs}
//   POST /admin/products/:sku            {priceCents?, stock?}  changes price/stock (to test cache invalidation)

import { randomUUID } from 'node:crypto';
import http from 'node:http';

const cfg = {
  latencyMs: Number(process.env.ERP_LATENCY_MS ?? 300),
  jitterMs: Number(process.env.ERP_JITTER_MS ?? 200),
  errorRate: Number(process.env.ERP_ERROR_RATE ?? 0.1),
  timeoutRate: Number(process.env.ERP_TIMEOUT_RATE ?? 0.05),
  invoiceLatencyMs: Number(process.env.ERP_INVOICE_LATENCY_MS ?? 1500),
  hangMs: 30_000,
};

const products = new Map(
  [
    ['CASE-IPH15-BLK', 'iPhone 15 Case Black', 4990, 10],
    ['CASE-IPH15-CLR', 'iPhone 15 Case Clear', 3990, 50],
    ['CASE-S24-BLU', 'Galaxy S24 Case Blue', 4590, 3],
    ['CASE-S24-RED', 'Galaxy S24 Case Red', 4590, 0],
    ['CASE-PX8-GRN', 'Pixel 8 Case Green', 5290, 25],
  ].map(([sku, name, priceCents, stock]) => [
    sku,
    { sku, name, priceCents, stock, version: 1, updatedAt: new Date().toISOString() },
  ]),
);
const invoices = []; // intentionally not unique per orderId

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });

// Chaos applied to business routes. Returns true if it already responded.
async function chaos(res, baseLatency) {
  await sleep(baseLatency + Math.random() * cfg.jitterMs);
  const roll = Math.random();
  if (roll < cfg.timeoutRate) {
    await sleep(cfg.hangMs);
    send(res, 504, { error: 'ERP_TIMEOUT' });
    return true;
  }
  if (roll < cfg.timeoutRate + cfg.errorRate) {
    send(res, 503, { error: 'ERP_UNAVAILABLE' });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://erp');
  const path = url.pathname;
  const started = Date.now();
  res.on('finish', () =>
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'erp-mock',
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Date.now() - started,
        correlationId: req.headers['x-correlation-id'],
      }),
    ),
  );

  if (path === '/health') return send(res, 200, { status: 'ok' });

  if (path === '/admin/config') {
    if (req.method === 'POST') Object.assign(cfg, await readBody(req));
    return send(res, 200, cfg);
  }

  const adminProduct = path.match(/^\/admin\/products\/([^/]+)$/);
  if (adminProduct && req.method === 'POST') {
    const p = products.get(adminProduct[1]);
    if (!p) return send(res, 404, { error: 'NOT_FOUND' });
    const body = await readBody(req);
    if (body?.priceCents !== undefined) p.priceCents = body.priceCents;
    if (body?.stock !== undefined) p.stock = body.stock;
    p.version += 1;
    p.updatedAt = new Date().toISOString();
    return send(res, 200, p);
  }

  if (path === '/products' && req.method === 'GET') {
    if (await chaos(res, cfg.latencyMs)) return;
    return send(res, 200, { items: [...products.values()], generatedAt: new Date().toISOString() });
  }

  const product = path.match(/^\/products\/([^/]+)$/);
  if (product && req.method === 'GET') {
    if (await chaos(res, cfg.latencyMs)) return;
    const p = products.get(product[1]);
    return p ? send(res, 200, p) : send(res, 404, { error: 'NOT_FOUND' });
  }

  if (path === '/invoices' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.orderId || !Array.isArray(body.items)) return send(res, 400, { error: 'INVALID_PAYLOAD' });
    if (await chaos(res, cfg.invoiceLatencyMs)) return;
    for (const it of body.items) {
      const p = products.get(it.sku);
      if (p) {
        p.stock = Math.max(0, p.stock - it.quantity);
        p.version += 1;
      }
    }
    const invoice = {
      invoiceId: randomUUID(),
      orderId: body.orderId,
      items: body.items,
      createdAt: new Date().toISOString(),
    };
    invoices.push(invoice);
    return send(res, 201, invoice);
  }

  if (path === '/invoices' && req.method === 'GET') {
    const orderId = url.searchParams.get('orderId');
    return send(res, 200, { items: invoices.filter((i) => !orderId || i.orderId === orderId) });
  }

  send(res, 404, { error: 'NOT_FOUND' });
});

server.listen(Number(process.env.PORT ?? 4000), () =>
  console.log(JSON.stringify({ level: 'info', msg: 'erp-mock up', cfg })),
);
