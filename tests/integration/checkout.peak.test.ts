import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App, AppDeps } from '../../src/api/app';
import type { CheckoutService } from '../../src/modules/checkout/service';
import type { Db } from '../../src/shared/db';
import { createRedis, type RedisClient } from '../../src/shared/redis';
import { createServices, createTestApp, createTestRedis } from '../support/app';
import { createTestDb, Fixtures } from '../support/db';
import { uniqueId } from '../support/env';
import { FakeErp } from '../support/fake-erp';

let db: Db;
let redis: RedisClient;
let fx: Fixtures;
let erp: FakeErp;
let sku: string;
const apps: App[] = [];

beforeAll(() => {
  db = createTestDb();
  redis = createTestRedis();
  fx = new Fixtures(db);
});
beforeEach(async () => {
  sku = await fx.sku({ available: 5, priceCents: 4990 });
  erp = new FakeErp([{ sku, priceCents: 4990 }]);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await fx.cleanup();
});
afterAll(async () => {
  await db.end();
  await redis.quit();
});

async function start(overrides: Partial<Omit<AppDeps, 'logger'>> = {}): Promise<App> {
  const { app } = await createTestApp(db, redis, erp, overrides);
  apps.push(app);
  return app;
}

function checkout(app: App, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/checkout',
    headers: { 'content-type': 'application/json', 'idempotency-key': uniqueId('k'), ...headers },
    payload: JSON.stringify({ items: [{ sku, quantity: 1 }] }),
  });
}

/** Real checkout service that waits for `open()` before placing, to hold concurrency slots deterministically. */
function gatedCheckout(): { service: CheckoutService; open: () => void } {
  const real = createServices(db, redis, erp).checkout;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    service: {
      async place(cmd) {
        await gate;
        return real.place(cmd);
      },
    },
    open,
  };
}

const tight = (max: number) => ({ checkoutLimits: { rateLimit: { max, windowS: 60 } } });

describe('POST /checkout rate limit (per client IP, Redis counters)', () => {
  it('429 RATE_LIMITED with Retry-After once a client exceeds its budget; nothing is reserved', async () => {
    const app = await start(tight(2));

    expect((await checkout(app)).statusCode).toBe(202);
    const second = await checkout(app);
    expect(second.statusCode).toBe(202);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');

    const limited = await checkout(app);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringMatching(/^Too many checkout attempts, retry in \d+ \w+$/),
      },
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['x-ratelimit-limit']).toBe('2');
    expect(limited.headers['x-correlation-id']).toEqual(expect.any(String));
    expect(await fx.inventory(sku)).toEqual({ available: 3, reserved: 2 });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/checkout_requests_total\{outcome="rate_limited"\} [1-9]/);
  });

  it('counts each client separately when X-Forwarded-For is trusted', async () => {
    const app = await start({ ...tight(1), trustProxy: true });

    expect((await checkout(app, { 'x-forwarded-for': '10.0.0.1' })).statusCode).toBe(202);
    expect((await checkout(app, { 'x-forwarded-for': '10.0.0.1' })).statusCode).toBe(429);
    expect((await checkout(app, { 'x-forwarded-for': '10.0.0.2' })).statusCode).toBe(202);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted, so a client cannot dodge its budget', async () => {
    const app = await start(tight(1));

    expect((await checkout(app, { 'x-forwarded-for': '10.0.0.1' })).statusCode).toBe(202);
    expect((await checkout(app, { 'x-forwarded-for': '10.0.0.2' })).statusCode).toBe(429);
  });

  it('shares the budget between instances through Redis', async () => {
    const namespace = `${uniqueId('rl')}:`;
    const a = await start({ ...tight(1), rateLimitNamespace: namespace });
    const b = await start({ ...tight(1), rateLimitNamespace: namespace });

    expect((await checkout(a)).statusCode).toBe(202);
    expect((await checkout(b)).statusCode).toBe(429);
  });

  it('fails open when Redis is unreachable: checkout keeps working', async () => {
    const down = createRedis('redis://127.0.0.1:1');
    down.on('error', () => undefined);
    try {
      const app = await start({ ...tight(1), rateLimitRedis: down });
      expect((await checkout(app)).statusCode).toBe(202);
      expect((await checkout(app)).statusCode).toBe(202);
    } finally {
      down.disconnect();
    }
  });
});

describe('POST /checkout concurrency limit (virtual queue)', () => {
  it('a request waits for a free slot and then succeeds', async () => {
    const gated = gatedCheckout();
    const app = await start({
      checkout: gated.service,
      checkoutLimits: { max: 1, maxQueue: 5, queueTimeoutMs: 5000 },
    });

    const first = checkout(app);
    const queued = checkout(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    gated.open();

    expect((await first).statusCode).toBe(202);
    expect((await queued).statusCode).toBe(202);
  });

  it('503 OVERLOADED with Retry-After when the queue is full; a retry with the same key gets the order', async () => {
    const gated = gatedCheckout();
    const app = await start({
      checkout: gated.service,
      checkoutLimits: { max: 1, maxQueue: 0, queueTimeoutMs: 2000 },
    });
    const key = uniqueId('k');

    const holding = checkout(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const shed = await checkout(app, { 'idempotency-key': key });

    expect(shed.statusCode).toBe(503);
    expect(shed.json()).toMatchObject({ error: { code: 'OVERLOADED', details: { retryAfterS: 2 } } });
    expect(shed.headers['retry-after']).toBe('2');
    // Shed before the service ran: only the holding request may reserve.
    gated.open();
    expect((await holding).statusCode).toBe(202);
    expect(await fx.inventory(sku)).toEqual({ available: 4, reserved: 1 });

    const retried = await checkout(app, { 'idempotency-key': key });
    const again = await checkout(app, { 'idempotency-key': key });
    expect(retried.statusCode).toBe(202);
    expect(again.json().orderId).toBe(retried.json().orderId);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toMatch(/checkout_requests_total\{outcome="shed"\} [1-9]/);
    expect(metrics.body).toContain('checkout_inflight 0');
  });

  it('503 OVERLOADED when a queued request waits longer than the queue timeout', async () => {
    const gated = gatedCheckout();
    const app = await start({
      checkout: gated.service,
      checkoutLimits: { max: 1, maxQueue: 5, queueTimeoutMs: 50 },
    });

    const holding = checkout(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const timedOut = await checkout(app);
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error.code).toBe('OVERLOADED');
    expect(timedOut.headers['retry-after']).toBe('1');
    gated.open();
    expect((await holding).statusCode).toBe(202);
  });

  it('invalid requests are rejected without taking a slot', async () => {
    const gated = gatedCheckout();
    const app = await start({
      checkout: gated.service,
      checkoutLimits: { max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
    });

    const holding = checkout(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const invalid = await app.inject({
      method: 'POST',
      url: '/checkout',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ items: [{ sku, quantity: 1 }] }),
    });
    expect(invalid.statusCode).toBe(400);
    gated.open();
    await holding;
  });
});
