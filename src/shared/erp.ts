import { z } from 'zod';
import { currentContext } from './context';
import { type ErpOutcome, erpRequestDuration, erpRequests } from './metrics';
import { withSpan } from './tracing';

export const erpProductSchema = z.object({
  sku: z.string(),
  name: z.string(),
  priceCents: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  updatedAt: z.string(),
});
export type ErpProduct = z.infer<typeof erpProductSchema>;

export const erpInvoiceSchema = z.object({
  invoiceId: z.string(),
  orderId: z.string(),
  createdAt: z.string(),
});
export type ErpInvoice = z.infer<typeof erpInvoiceSchema>;

export interface InvoiceItem {
  sku: string;
  quantity: number;
}

/** The ERP is slow and unstable; callers decide how to degrade based on `kind`. */
export type ErpErrorKind = 'timeout' | 'unavailable' | 'client';

export class ErpError extends Error {
  constructor(
    readonly kind: ErpErrorKind,
    readonly operation: string,
    readonly status?: number,
  ) {
    super(`ERP ${operation} failed: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'ErpError';
  }

  /** Timeouts and 5xx may succeed on retry; 4xx means our request is wrong and retrying will not help. */
  get retryable(): boolean {
    return this.kind !== 'client';
  }
}

export interface ErpClient {
  listProducts(): Promise<ErpProduct[]>;
  createInvoice(orderId: string, items: InvoiceItem[]): Promise<ErpInvoice>;
  findInvoices(orderId: string): Promise<ErpInvoice[]>;
}

type FetchFn = typeof fetch;

export function createHttpErpClient(opts: { baseUrl: string; timeoutMs: number; fetchFn?: FetchFn }): ErpClient {
  const fetchFn = opts.fetchFn ?? fetch;

  async function call<T>(
    operation: string,
    spanName: string,
    path: string,
    init: RequestInit,
    parse: (body: unknown) => T,
  ): Promise<T> {
    return withSpan(spanName, { 'erp.operation': operation }, async (span) => {
      const started = process.hrtime.bigint();
      let outcome: ErpOutcome = 'success';
      try {
        const correlationId = currentContext()?.correlationId;
        let res: Response;
        try {
          res = await fetchFn(`${opts.baseUrl}${path}`, {
            ...init,
            // Every ERP call is bounded: a hung ERP must not pin API requests or worker slots.
            signal: AbortSignal.timeout(opts.timeoutMs),
            headers: {
              'content-type': 'application/json',
              ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
            },
          });
        } catch (err) {
          const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          outcome = isTimeout ? 'timeout' : 'error';
          throw new ErpError(isTimeout ? 'timeout' : 'unavailable', operation);
        }
        span.setAttribute('http.response.status_code', res.status);
        if (res.status >= 500) {
          outcome = res.status === 504 ? 'timeout' : 'error';
          throw new ErpError(res.status === 504 ? 'timeout' : 'unavailable', operation, res.status);
        }
        if (res.status >= 400) {
          outcome = 'client_error';
          throw new ErpError('client', operation, res.status);
        }
        try {
          return parse(await res.json());
        } catch {
          outcome = 'error';
          throw new ErpError('unavailable', operation, res.status);
        }
      } finally {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        erpRequests.inc({ operation, outcome });
        erpRequestDuration.observe({ operation, outcome }, seconds);
        span.setAttribute('erp.outcome', outcome);
      }
    });
  }

  return {
    listProducts: () =>
      call(
        'list_products',
        'erp.products',
        '/products',
        { method: 'GET' },
        (body) => z.object({ items: z.array(erpProductSchema) }).parse(body).items,
      ),
    createInvoice: (orderId, items) =>
      call(
        'create_invoice',
        'erp.invoice',
        '/invoices',
        { method: 'POST', body: JSON.stringify({ orderId, items }) },
        (body) => erpInvoiceSchema.parse(body),
      ),
    findInvoices: (orderId) =>
      call(
        'find_invoices',
        'erp.lookup',
        `/invoices?orderId=${encodeURIComponent(orderId)}`,
        { method: 'GET' },
        (body) => z.object({ items: z.array(erpInvoiceSchema) }).parse(body).items,
      ),
  };
}
