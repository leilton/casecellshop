import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/api/app';
import type { Db } from '../../src/shared/db';
import type { RedisClient } from '../../src/shared/redis';
import { createTestApp, createTestRedis } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';
import { contractErrors } from '../support/openapi';

let db: Db;
let redis: RedisClient;
let fx: Fixtures;
let app: App;
let downApp: App;
let sku: string;
let emptySku: string;

beforeAll(async () => {
  db = createTestDb();
  redis = createTestRedis();
  fx = new Fixtures(db);
  sku = await fx.sku({ available: 5, priceCents: 4990 });
  emptySku = await fx.sku({ available: 0 });
  ({ app } = await createTestApp(db, redis, new FakeErp([{ sku }, { sku: emptySku }])));
  ({ app: downApp } = await createTestApp(db, redis, new FakeErp([{ sku }]).failAlways('listProducts', 'timeout')));
});
afterAll(async () => {
  await app.close();
  await downApp.close();
  await fx.cleanup();
  await db.end();
  await redis.quit();
});

const json = { 'content-type': 'application/json' };

interface Case {
  name: string;
  method: 'get' | 'post';
  specPath: string;
  status: number;
  call: () => Promise<{ statusCode: number; json: () => unknown }>;
}

const cases: Case[] = [
  {
    name: 'products 200',
    method: 'get',
    specPath: '/products',
    status: 200,
    call: () => app.inject({ url: '/products' }),
  },
  {
    name: 'products 400',
    method: 'get',
    specPath: '/products',
    status: 400,
    call: () => app.inject({ url: '/products?sku=bad sku' }),
  },
  {
    name: 'products 404',
    method: 'get',
    specPath: '/products',
    status: 404,
    call: () => app.inject({ url: '/products?sku=CASE-UNKNOWN' }),
  },
  {
    name: 'products 503',
    method: 'get',
    specPath: '/products',
    status: 503,
    call: () => downApp.inject({ url: '/products' }),
  },
  {
    name: 'checkout 202',
    method: 'post',
    specPath: '/checkout',
    status: 202,
    call: () =>
      app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { ...json, 'idempotency-key': uniqueId('c') },
        payload: { items: [{ sku, quantity: 1 }] },
      }),
  },
  {
    name: 'checkout 400',
    method: 'post',
    specPath: '/checkout',
    status: 400,
    call: () => app.inject({ method: 'POST', url: '/checkout', headers: json, payload: { items: [] } }),
  },
  {
    name: 'checkout 409',
    method: 'post',
    specPath: '/checkout',
    status: 409,
    call: () =>
      app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { ...json, 'idempotency-key': uniqueId('c') },
        payload: { items: [{ sku: emptySku, quantity: 1 }] },
      }),
  },
  {
    name: 'checkout 415',
    method: 'post',
    specPath: '/checkout',
    status: 415,
    call: () =>
      app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { 'content-type': 'text/plain', 'idempotency-key': uniqueId('c') },
        payload: 'x',
      }),
  },
  {
    name: 'checkout 422',
    method: 'post',
    specPath: '/checkout',
    status: 422,
    call: () =>
      app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { ...json, 'idempotency-key': uniqueId('c') },
        payload: { items: [{ sku: 'CASE-UNKNOWN', quantity: 1 }] },
      }),
  },
  {
    name: 'checkout 429',
    method: 'post',
    specPath: '/checkout',
    status: 429,
    call: async () => {
      const { app: limited } = await createTestApp(db, redis, new FakeErp([{ sku }]), {
        checkoutLimits: { rateLimit: { max: 1, windowS: 60 } },
      });
      try {
        const send = () =>
          limited.inject({
            method: 'POST',
            url: '/checkout',
            headers: { ...json, 'idempotency-key': uniqueId('c') },
            payload: { items: [{ sku, quantity: 1 }] },
          });
        await send();
        return await send();
      } finally {
        await limited.close();
      }
    },
  },
  {
    name: 'checkout 503 overloaded',
    method: 'post',
    specPath: '/checkout',
    status: 503,
    call: async () => {
      // No slots and no queue: every checkout is shed before the service runs.
      const { app: full } = await createTestApp(db, redis, new FakeErp([{ sku }]), {
        checkoutLimits: { max: 1, maxQueue: 0 },
        checkout: { place: () => new Promise(() => undefined) },
      });
      try {
        const send = () =>
          full.inject({
            method: 'POST',
            url: '/checkout',
            headers: { ...json, 'idempotency-key': uniqueId('c') },
            payload: { items: [{ sku, quantity: 1 }] },
          });
        void send();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await send();
      } finally {
        await full.close();
      }
    },
  },
  {
    name: 'order status 200',
    method: 'get',
    specPath: '/orders/{orderId}/status',
    status: 200,
    call: async () => {
      const placed = await app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { ...json, 'idempotency-key': uniqueId('c') },
        payload: { items: [{ sku, quantity: 1 }] },
      });
      return app.inject({ url: placed.json().statusUrl });
    },
  },
  {
    name: 'order status 400',
    method: 'get',
    specPath: '/orders/{orderId}/status',
    status: 400,
    call: () => app.inject({ url: '/orders/not-a-uuid/status' }),
  },
  {
    name: 'order status 404',
    method: 'get',
    specPath: '/orders/{orderId}/status',
    status: 404,
    call: () => app.inject({ url: '/orders/2f1e0d9c-8b7a-4695-8473-625140302f1e/status' }),
  },
  {
    name: 'order cancel 200',
    method: 'post',
    specPath: '/orders/{orderId}/cancel',
    status: 200,
    call: async () => {
      const placed = await app.inject({
        method: 'POST',
        url: '/checkout',
        headers: { ...json, 'idempotency-key': uniqueId('c') },
        payload: { items: [{ sku, quantity: 1 }] },
      });
      return app.inject({ method: 'POST', url: `/orders/${placed.json().orderId}/cancel` });
    },
  },
  {
    name: 'order cancel 400',
    method: 'post',
    specPath: '/orders/{orderId}/cancel',
    status: 400,
    call: () => app.inject({ method: 'POST', url: '/orders/not-a-uuid/cancel' }),
  },
  {
    name: 'order cancel 404',
    method: 'post',
    specPath: '/orders/{orderId}/cancel',
    status: 404,
    call: () => app.inject({ method: 'POST', url: '/orders/2f1e0d9c-8b7a-4695-8473-625140302f1e/cancel' }),
  },
  { name: 'health 200', method: 'get', specPath: '/health', status: 200, call: () => app.inject({ url: '/health' }) },
];

describe('responses match docs/openapi.yaml', () => {
  it.each(cases)('$name', async ({ method, specPath, status, call }) => {
    const res = await call();

    expect(res.statusCode).toBe(status);
    expect(contractErrors(method, specPath, res.statusCode, res.json())).toEqual([]);
  });

  it('the contract validator rejects a body that does not match (guards against a vacuous test)', () => {
    expect(contractErrors('get', '/products', 200, { items: [{ sku: 1 }] })).not.toEqual([]);
    expect(contractErrors('get', '/products', 418, {})).toEqual(['status 418 is not documented for get /products']);
  });
});
