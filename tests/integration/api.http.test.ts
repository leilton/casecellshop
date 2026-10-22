import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/api/app';
import type { CatalogService } from '../../src/modules/catalog/service';
import type { CheckoutService } from '../../src/modules/checkout/service';
import type { OrdersService } from '../../src/modules/orders/service';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { createTestApp, createTestRedis } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';
import { connectionRefused } from '../support/fakes';

let db: Db;
let redis: RedisClient;
let fx: Fixtures;
let erp: FakeErp;
let app: App;
let sku: string;
let emptySku: string;

beforeAll(() => {
  db = createTestDb();
  redis = createTestRedis();
  fx = new Fixtures(db);
});
beforeEach(async () => {
  sku = await fx.sku({ available: 5, priceCents: 4990 });
  emptySku = await fx.sku({ available: 0 });
  erp = new FakeErp([{ sku, priceCents: 4990 }, { sku: emptySku }]);
  ({ app } = await createTestApp(db, redis, erp));
});
afterEach(async () => {
  await app.close();
  await fx.cleanup();
});
afterAll(async () => {
  await db.end();
  await redis.quit();
});

const json = { 'content-type': 'application/json' };

function checkout(body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/checkout',
    headers: { ...json, 'idempotency-key': uniqueId('k'), ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function expectError(
  res: { statusCode: number; json: () => unknown; headers: Record<string, unknown> },
  status: number,
  code: string,
) {
  expect(res.statusCode).toBe(status);
  expect(res.json()).toMatchObject({ error: { code, message: expect.any(String) } });
  expect(res.headers['x-correlation-id']).toEqual(expect.any(String));
}

/** A service stub whose every method throws `err`, for the 500/503 paths. */
function throwing<T extends object>(err: unknown): T {
  return new Proxy({} as T, { get: () => async () => Promise.reject(err) });
}

async function appWith(overrides: { catalog?: CatalogService; checkout?: CheckoutService; orders?: OrdersService }) {
  await app.close();
  ({ app } = await createTestApp(db, redis, erp, overrides));
}

describe('correlation id', () => {
  it('echoes a valid x-correlation-id and generates one otherwise', async () => {
    const echoed = await app.inject({ method: 'GET', url: '/products', headers: { 'x-correlation-id': 'abc-123' } });
    expect(echoed.headers['x-correlation-id']).toBe('abc-123');

    const generated = await app.inject({ method: 'GET', url: '/products', headers: { 'x-correlation-id': 'bad id!' } });
    expect(generated.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /products', () => {
  it('200 with items, cache metadata and x-cache miss then hit', async () => {
    const first = await app.inject({ method: 'GET', url: '/products' });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-cache']).toBe('miss');
    expect(first.headers['cache-control']).toBe('public, max-age=5');
    expect(first.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ sku, priceCents: 4990, available: 5, inStock: true })]),
    );

    const second = await app.inject({ method: 'GET', url: '/products' });
    expect(second.headers['x-cache']).toBe('hit');
    expect(erp.calls.listProducts).toBe(1);
  });

  it('200 filtered by ?sku=', async () => {
    const res = await app.inject({ method: 'GET', url: `/products?sku=${emptySku}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ sku: emptySku, available: 0, inStock: false })]);
  });

  it('200 stale when the ERP fails after the fresh TTL, with no-store', async () => {
    await app.inject({ method: 'GET', url: '/products' });
    // Age the cached entry past its fresh TTL but inside the stale window.
    const keys = await redis.keys('*catalog:v1:products');
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (entry.value?.some?.((p: { sku: string }) => p.sku === sku)) {
        entry.freshUntil = Date.now() - 1;
        await redis.set(key, JSON.stringify(entry), 'PX', 60_000);
      }
    }
    erp.failAlways('listProducts', 'timeout');

    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-cache']).toBe('stale');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().meta).toMatchObject({ stale: true, cache: { products: 'stale' } });
  });

  it('404 PRODUCT_NOT_FOUND for an unknown sku', async () => {
    expectError(
      await app.inject({ method: 'GET', url: '/products?sku=CASE-DOES-NOT-EXIST' }),
      404,
      'PRODUCT_NOT_FOUND',
    );
  });

  it.each([['lowercase'], ['has%20space'], ['-STARTS-WITH-DASH']])('400 VALIDATION_ERROR for ?sku=%s', async (bad) => {
    expectError(await app.inject({ method: 'GET', url: `/products?sku=${bad}` }), 400, 'VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR for an unknown query parameter', async () => {
    expectError(await app.inject({ method: 'GET', url: '/products?page=2' }), 400, 'VALIDATION_ERROR');
  });

  it('503 CATALOG_UNAVAILABLE when the ERP is down and nothing is cached', async () => {
    erp.failAlways('listProducts', 'unavailable');
    expectError(await app.inject({ method: 'GET', url: '/products' }), 503, 'CATALOG_UNAVAILABLE');
  });

  it('503 DEPENDENCY_UNAVAILABLE when a dependency connection is refused', async () => {
    await appWith({ catalog: throwing<CatalogService>(connectionRefused()) });
    expectError(await app.inject({ method: 'GET', url: '/products' }), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('500 INTERNAL_ERROR on an unexpected failure, without leaking internals', async () => {
    await appWith({ catalog: throwing<CatalogService>(new TypeError('secret stack detail')) });
    const res = await app.inject({ method: 'GET', url: '/products' });
    expectError(res, 500, 'INTERNAL_ERROR');
    expect(res.body).not.toContain('secret stack detail');
  });
});

describe('POST /checkout', () => {
  it('202 with orderId, status, statusUrl and Location', async () => {
    const res = await checkout({ items: [{ sku, quantity: 2 }] });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toEqual({
      orderId: expect.any(String),
      status: 'RESERVED',
      statusUrl: `/orders/${body.orderId}/status`,
    });
    expect(res.headers.location).toBe(body.statusUrl);
    expect(await fx.count('outbox', body.orderId)).toBe(1);
  });

  it('202 with the same orderId for a repeated Idempotency-Key', async () => {
    const headers = { 'idempotency-key': uniqueId('same') };
    const a = await checkout({ items: [{ sku, quantity: 1 }] }, headers);
    const b = await checkout({ items: [{ sku, quantity: 1 }] }, headers);

    expect(b.statusCode).toBe(202);
    expect(b.json().orderId).toBe(a.json().orderId);
  });

  it('400 MISSING_IDEMPOTENCY_KEY without the header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: json,
      payload: JSON.stringify({ items: [{ sku, quantity: 1 }] }),
    });
    expectError(res, 400, 'MISSING_IDEMPOTENCY_KEY');
  });

  it.each([
    ['empty', ''],
    ['too long', 'k'.repeat(129)],
    ['invalid characters', 'key with spaces'],
  ])('400 INVALID_IDEMPOTENCY_KEY when the key is %s', async (_label, key) => {
    expectError(
      await checkout({ items: [{ sku, quantity: 1 }] }, { 'idempotency-key': key }),
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  });

  it.each([
    ['an empty object', {}],
    ['an empty items array', { items: [] }],
    ['more than 10 items', { items: Array.from({ length: 11 }, (_, i) => ({ sku: `CASE-${i}`, quantity: 1 })) }],
    ['quantity 0', { items: [{ sku: 'CASE-A', quantity: 0 }] }],
    ['a negative quantity', { items: [{ sku: 'CASE-A', quantity: -1 }] }],
    ['a fractional quantity', { items: [{ sku: 'CASE-A', quantity: 1.5 }] }],
    ['quantity above 5', { items: [{ sku: 'CASE-A', quantity: 6 }] }],
    ['a quantity sent as string', { items: [{ sku: 'CASE-A', quantity: '1' }] }],
    [
      'a duplicated sku',
      {
        items: [
          { sku: 'CASE-A', quantity: 1 },
          { sku: 'CASE-A', quantity: 1 },
        ],
      },
    ],
    ['an extra field', { items: [{ sku: 'CASE-A', quantity: 1 }], coupon: 'FREE' }],
    ['an extra item field (client price)', { items: [{ sku: 'CASE-A', quantity: 1, priceCents: 1 }] }],
    ['a malformed sku', { items: [{ sku: 'case a', quantity: 1 }] }],
    ['items not being an array', { items: 'CASE-A' }],
  ])('400 VALIDATION_ERROR for %s', async (_label, body) => {
    const res = await checkout(body);
    expectError(res, 400, 'VALIDATION_ERROR');
    expect(res.json().error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]),
    );
  });

  it('400 INVALID_JSON for a broken body', async () => {
    expectError(await checkout('{"items": ['), 400, 'INVALID_JSON');
  });

  it('400 for an empty body with a JSON content type', async () => {
    const res = await checkout('');
    expect(res.statusCode).toBe(400);
    expect(['INVALID_JSON', 'VALIDATION_ERROR']).toContain(res.json().error.code);
  });

  it('415 UNSUPPORTED_MEDIA_TYPE for text/plain', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { 'content-type': 'text/plain', 'idempotency-key': uniqueId('k') },
      payload: 'items=CASE-A',
    });
    expectError(res, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('409 OUT_OF_STOCK lists the SKUs and reserves nothing', async () => {
    const res = await checkout({
      items: [
        { sku, quantity: 1 },
        { sku: emptySku, quantity: 1 },
      ],
    });

    expectError(res, 409, 'OUT_OF_STOCK');
    expect(res.json().error.details).toEqual({ skus: [emptySku] });
    expect(await fx.inventory(sku)).toEqual({ available: 5, reserved: 0 });
  });

  it('422 IDEMPOTENCY_KEY_REUSED for the same key with a different payload', async () => {
    const headers = { 'idempotency-key': uniqueId('reuse') };
    await checkout({ items: [{ sku, quantity: 1 }] }, headers);
    expectError(await checkout({ items: [{ sku, quantity: 2 }] }, headers), 422, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('422 UNKNOWN_SKU for a sku that is not in the catalog', async () => {
    expectError(await checkout({ items: [{ sku: 'CASE-NOT-SOLD', quantity: 1 }] }), 422, 'UNKNOWN_SKU');
  });

  it('503 DEPENDENCY_UNAVAILABLE when the database is unreachable', async () => {
    await appWith({ checkout: throwing<CheckoutService>(connectionRefused()) });
    expectError(await checkout({ items: [{ sku, quantity: 1 }] }), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('500 INTERNAL_ERROR on an unexpected repository failure', async () => {
    await appWith({ checkout: throwing<CheckoutService>(new Error('constraint exploded')) });
    const res = await checkout({ items: [{ sku, quantity: 1 }] });
    expectError(res, 500, 'INTERNAL_ERROR');
    expect(res.body).not.toContain('constraint exploded');
  });
});

describe('GET /orders/:id/status', () => {
  it('200 with status, items and history (no-store)', async () => {
    const placed = (await checkout({ items: [{ sku, quantity: 1 }] })).json();

    const res = await app.inject({ method: 'GET', url: placed.statusUrl });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      orderId: placed.orderId,
      status: 'RESERVED',
      totalCents: 4990,
      invoiceId: null,
      attempts: 0,
      history: [{ from: null, to: 'RESERVED' }],
    });
  });

  it('400 VALIDATION_ERROR for an id that is not a UUID', async () => {
    expectError(await app.inject({ method: 'GET', url: '/orders/123/status' }), 400, 'VALIDATION_ERROR');
  });

  it('404 ORDER_NOT_FOUND for an unknown UUID', async () => {
    expectError(
      await app.inject({ method: 'GET', url: '/orders/2f1e0d9c-8b7a-4695-8473-625140302f1e/status' }),
      404,
      'ORDER_NOT_FOUND',
    );
  });

  it('500 INTERNAL_ERROR on an unexpected failure', async () => {
    await appWith({ orders: throwing<OrdersService>(new Error('boom')) });
    expectError(
      await app.inject({ method: 'GET', url: '/orders/2f1e0d9c-8b7a-4695-8473-625140302f1e/status' }),
      500,
      'INTERNAL_ERROR',
    );
  });
});

describe('POST /orders/:id/cancel', () => {
  const cancel = (orderId: string) => app.inject({ method: 'POST', url: `/orders/${orderId}/cancel` });

  it('200 CANCELLED, stock back on the shelf, and the same answer on a retry (no-store)', async () => {
    const placed = (await checkout({ items: [{ sku, quantity: 2 }] })).json();

    const first = await cancel(placed.orderId);
    const second = await cancel(placed.orderId);

    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toMatchObject({ orderId: placed.orderId, status: 'CANCELLED' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await fx.inventory(sku)).toEqual({ available: 5, reserved: 0 });
  });

  it('409 ORDER_NOT_CANCELLABLE once invoicing has started', async () => {
    const placed = (await checkout({ items: [{ sku, quantity: 1 }] })).json();
    await db.query(`UPDATE orders SET status = 'INVOICING' WHERE id = $1`, [placed.orderId]);

    const res = await cancel(placed.orderId);

    expectError(res, 409, 'ORDER_NOT_CANCELLABLE');
    expect(res.json().error.details).toEqual({ status: 'INVOICING' });
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 1 });
  });

  it('400 VALIDATION_ERROR for an id that is not a UUID', async () => {
    expectError(await cancel('123'), 400, 'VALIDATION_ERROR');
  });

  it('404 ORDER_NOT_FOUND for an unknown UUID', async () => {
    expectError(await cancel('2f1e0d9c-8b7a-4695-8473-625140302f1e'), 404, 'ORDER_NOT_FOUND');
  });
});

describe('operational and unknown routes', () => {
  it('404 ROUTE_NOT_FOUND for an unknown path', async () => {
    expectError(await app.inject({ method: 'GET', url: '/nope' }), 404, 'ROUTE_NOT_FOUND');
  });

  it('404 ROUTE_NOT_FOUND for a known path with the wrong method', async () => {
    expectError(await app.inject({ method: 'DELETE', url: '/products' }), 404, 'ROUTE_NOT_FOUND');
  });

  it('/health is 200 when every dependency is ok and 503 when one is degraded', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    await app.close();
    ({ app } = await createTestApp(db, redis, erp, { health: async () => ({ postgres: 'ok', erp: 'timeout' }) }));
    const degraded = await app.inject({ method: 'GET', url: '/health' });
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toEqual({ status: 'degraded', deps: { postgres: 'ok', erp: 'timeout' } });
  });

  it('/metrics exposes the contract metrics in Prometheus format, labelled by route pattern', async () => {
    const placed = (await checkout({ items: [{ sku, quantity: 1 }] })).json();
    await app.inject({ method: 'GET', url: placed.statusUrl });
    await app.inject({ method: 'GET', url: '/products' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('checkout_requests_total{outcome="accepted"}');
    expect(res.body).toMatch(/cache_requests_total\{cache="products",result="(miss|hit)"\}/);
    expect(res.body).toContain('route="/orders/:id/status"');
    expect(res.body).not.toContain(placed.orderId);
  });

  it('/openapi.yaml serves the contract as text a browser shows instead of downloading', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('openapi: 3.1.0');
  });

  it('/docs serves Swagger UI and /docs/json the same contract', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Swagger UI');

    const json = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(json.statusCode).toBe(200);
    const spec = json.json();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/products', '/checkout', '/orders/{orderId}/status', '/docs']),
    );
  });
});
