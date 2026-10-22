import { randomUUID } from 'node:crypto';
import {
  type ErpClient,
  ErpError,
  type ErpErrorKind,
  type ErpInvoice,
  type ErpProduct,
  type InvoiceItem,
} from '../../src/shared/erp';

type Failure = ErpErrorKind | 'timeout-after-create';

/**
 * In-memory ERP with scripted failures. Like the real one, `createInvoice` is NOT idempotent, and
 * `timeout-after-create` reproduces the nasty case: the invoice is stored but the caller sees a timeout.
 */
export class FakeErp implements ErpClient {
  readonly invoices: ErpInvoice[] = [];
  readonly calls = { listProducts: 0, createInvoice: 0, findInvoices: 0 };
  private products: ErpProduct[];
  private readonly failures: Record<keyof FakeErp['calls'], Failure[]> = {
    listProducts: [],
    createInvoice: [],
    findInvoices: [],
  };
  /** Optional artificial latency, to make concurrent callers overlap. */
  delayMs = 0;

  constructor(products: Array<Partial<ErpProduct> & Pick<ErpProduct, 'sku'>> = []) {
    this.products = products.map((p) => ({
      name: p.sku,
      priceCents: 1000,
      stock: 10,
      version: 1,
      updatedAt: new Date().toISOString(),
      ...p,
    }));
  }

  /** The next `times` calls of `operation` fail with `kind`. */
  failNext(operation: keyof FakeErp['calls'], kind: Failure, times = 1): this {
    for (let i = 0; i < times; i++) this.failures[operation].push(kind);
    return this;
  }

  failAlways(operation: keyof FakeErp['calls'], kind: ErpErrorKind): this {
    return this.failNext(operation, kind, 1000);
  }

  heal(): this {
    for (const key of Object.keys(this.failures) as Array<keyof FakeErp['calls']>) this.failures[key] = [];
    return this;
  }

  setProduct(sku: string, patch: Partial<ErpProduct>): void {
    const p = this.products.find((x) => x.sku === sku);
    if (!p) throw new Error(`unknown sku ${sku}`);
    Object.assign(p, patch, { version: p.version + 1 });
  }

  async listProducts(): Promise<ErpProduct[]> {
    this.calls.listProducts += 1;
    await this.wait();
    this.maybeFail('listProducts', 'list_products');
    return this.products.map((p) => ({ ...p }));
  }

  async createInvoice(orderId: string, items: InvoiceItem[]): Promise<ErpInvoice> {
    this.calls.createInvoice += 1;
    await this.wait();
    const failure = this.failures.createInvoice.shift();
    const invoice = { invoiceId: randomUUID(), orderId, createdAt: new Date().toISOString() };
    if (failure === 'timeout-after-create') {
      this.invoices.push(invoice);
      void items;
      throw new ErpError('timeout', 'create_invoice');
    }
    if (failure) throw new ErpError(failure, 'create_invoice', failure === 'client' ? 400 : 503);
    this.invoices.push(invoice);
    return invoice;
  }

  async findInvoices(orderId: string): Promise<ErpInvoice[]> {
    this.calls.findInvoices += 1;
    await this.wait();
    this.maybeFail('findInvoices', 'find_invoices');
    return this.invoices.filter((i) => i.orderId === orderId);
  }

  invoicesFor(orderId: string): ErpInvoice[] {
    return this.invoices.filter((i) => i.orderId === orderId);
  }

  private async wait() {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  private maybeFail(operation: keyof FakeErp['calls'], name: string) {
    const failure = this.failures[operation].shift();
    if (!failure) return;
    const kind: ErpErrorKind = failure === 'timeout-after-create' ? 'timeout' : failure;
    throw new ErpError(kind, name, kind === 'client' ? 400 : 503);
  }
}
