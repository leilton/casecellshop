import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogService } from '../modules/catalog/service';
import type { CheckoutService } from '../modules/checkout/service';
import type { OrdersService } from '../modules/orders/service';
import { createLogger } from '../shared/logger';
import { type App, buildApp } from './app';

interface LogLine {
  msg?: string;
  correlationId?: string;
  requestId?: string;
  reqId?: string;
}

function capture() {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) if (line) lines.push(JSON.parse(line) as LogLine);
      callback();
    },
  });
  return { lines, logger: createLogger('test', 'info', stream) };
}

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

// The routes under test never reach the services, so empty stubs are enough.
async function listen(logger: ReturnType<typeof capture>['logger']) {
  app = await buildApp({
    logger,
    catalog: {} as CatalogService,
    checkout: {} as CheckoutService,
    orders: {} as OrdersService,
    health: async () => ({}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return `http://127.0.0.1:${address.port}`;
}

describe('request logs carry the correlation id', () => {
  it('puts the client correlationId on the incoming and the completed line, with the requestId', async () => {
    const { lines, logger } = capture();
    const baseUrl = await listen(logger);

    const res = await fetch(`${baseUrl}/nope`, { headers: { 'x-correlation-id': 'audit-123' } });
    await res.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res.headers.get('x-correlation-id')).toBe('audit-123');
    const incoming = lines.find((l) => l.msg === 'incoming request');
    const completed = lines.find((l) => l.msg === 'request completed');
    expect(incoming).toMatchObject({ correlationId: 'audit-123' });
    expect(incoming?.reqId).toEqual(expect.any(String));
    expect(completed).toMatchObject({ correlationId: 'audit-123', requestId: incoming?.reqId });
  });

  it('generates one id, shared by the response header and both log lines, when the client sends none', async () => {
    const { lines, logger } = capture();
    const baseUrl = await listen(logger);

    const res = await fetch(`${baseUrl}/nope`);
    await res.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const generated = res.headers.get('x-correlation-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.filter((l) => l.msg === 'incoming request' || l.msg === 'request completed')).toEqual([
      expect.objectContaining({ correlationId: generated }),
      expect.objectContaining({ correlationId: generated }),
    ]);
  });

  it('does not let concurrent requests borrow each other’s id', async () => {
    const { lines, logger } = capture();
    const baseUrl = await listen(logger);

    await Promise.all(
      ['a-1', 'b-2', 'c-3', 'd-4'].map(async (id) => {
        const res = await fetch(`${baseUrl}/nope`, { headers: { 'x-correlation-id': id } });
        await res.arrayBuffer();
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const incoming = lines.filter((l) => l.msg === 'incoming request').map((l) => l.correlationId);
    expect(incoming.sort()).toEqual(['a-1', 'b-2', 'c-3', 'd-4']);
  });
});
