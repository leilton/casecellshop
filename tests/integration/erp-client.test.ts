import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHttpErpClient, ErpError } from '../../src/shared/erp';
import { erpRequests } from '../../src/shared/metrics';
import { requireEnv, uniqueId } from '../support/env';
import { counterValue } from '../support/metrics';

const baseUrl = requireEnv('ERP_BASE_URL');
let original: Record<string, unknown>;

/** Chaos is driven through the mock's admin API, never by sleeping and hoping. */
async function setChaos(cfg: Record<string, number>) {
  const res = await fetch(`${baseUrl}/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  await res.arrayBuffer();
}

beforeAll(async () => {
  const res = await fetch(`${baseUrl}/admin/config`);
  original = (await res.json()) as Record<string, unknown>;
});
afterEach(() => setChaos({ errorRate: 0, timeoutRate: 0, latencyMs: 50, jitterMs: 0, invoiceLatencyMs: 50 }));
afterAll(() => setChaos(original as Record<string, number>));

describe('HTTP ERP client against the ERP mock', () => {
  it('lists products and records a success metric', async () => {
    await setChaos({ errorRate: 0, timeoutRate: 0, latencyMs: 10, jitterMs: 0 });
    const erp = createHttpErpClient({ baseUrl, timeoutMs: 2000 });
    const before = await counterValue(erpRequests, { operation: 'list_products', outcome: 'success' });

    const products = await erp.listProducts();

    expect(products.length).toBeGreaterThan(0);
    expect(products[0]).toEqual(expect.objectContaining({ sku: expect.any(String), priceCents: expect.any(Number) }));
    expect(await counterValue(erpRequests, { operation: 'list_products', outcome: 'success' })).toBe(before + 1);
  });

  it('classifies a 5xx as a retryable "unavailable" error', async () => {
    await setChaos({ errorRate: 1, timeoutRate: 0, latencyMs: 10, jitterMs: 0 });
    const erp = createHttpErpClient({ baseUrl, timeoutMs: 2000 });

    const err = await erp.listProducts().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErpError);
    expect(err).toMatchObject({ kind: 'unavailable', status: 503, retryable: true });
  });

  it('aborts a hung call at the configured timeout', async () => {
    await setChaos({ errorRate: 0, timeoutRate: 1, latencyMs: 10, jitterMs: 0 });
    const erp = createHttpErpClient({ baseUrl, timeoutMs: 300 });
    const started = Date.now();

    const err = await erp.listProducts().catch((e: unknown) => e);

    expect(err).toMatchObject({ kind: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('classifies a 4xx as a non-retryable client error', async () => {
    const fetchFn: typeof fetch = (url, init) =>
      // The mock answers 400 to an invoice without items; reuse its real validation.
      fetch(url, { ...init, body: JSON.stringify({ orderId: 'x' }) });
    const erp = createHttpErpClient({ baseUrl, timeoutMs: 2000, fetchFn });

    const err = await erp.createInvoice('x', []).catch((e: unknown) => e);

    expect(err).toMatchObject({ kind: 'client', status: 400, retryable: false });
  });

  it('demonstrates why lookup-before-retry exists: the ERP invoice endpoint is not idempotent', async () => {
    await setChaos({ errorRate: 0, timeoutRate: 0, invoiceLatencyMs: 10, jitterMs: 0 });
    const erp = createHttpErpClient({ baseUrl, timeoutMs: 2000 });
    const orderId = uniqueId('order');

    await erp.createInvoice(orderId, [{ sku: 'CASE-IPH15-CLR', quantity: 0 }]);
    await erp.createInvoice(orderId, [{ sku: 'CASE-IPH15-CLR', quantity: 0 }]);

    expect(await erp.findInvoices(orderId)).toHaveLength(2);
  });
});
