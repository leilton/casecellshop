import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
  requestId?: string;
  orderId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a correlation context that the logger, ERP client and outbox read implicitly. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutates the active context, e.g. once the orderId is known mid-request. */
export function setContextOrderId(orderId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.orderId = orderId;
}

export function enterContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}
