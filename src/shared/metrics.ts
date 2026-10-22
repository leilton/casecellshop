import client from 'prom-client';

// Names, types and labels are a contract with infra/prometheus/alerts.yml and the README table.
// Labels are bounded sets only (sku is a small catalog); never orderId or idempotency keys.

export const registry = client.register;

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route pattern',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
});

export const cacheRequests = new client.Counter({
  name: 'cache_requests_total',
  help: 'Storefront cache lookups by result',
  labelNames: ['cache', 'result'] as const,
});

export const checkoutRequests = new client.Counter({
  name: 'checkout_requests_total',
  help: 'Checkout attempts by outcome',
  labelNames: ['outcome'] as const,
});

export const checkoutInflight = new client.Gauge({
  name: 'checkout_inflight',
  help: 'Checkouts holding a concurrency slot on this instance',
});

export const checkoutQueueWaiting = new client.Gauge({
  name: 'checkout_queue_waiting',
  help: 'Checkouts waiting for a concurrency slot on this instance',
});

export const stockReservationConflicts = new client.Counter({
  name: 'stock_reservation_conflicts_total',
  help: 'Reservations rejected because available stock was insufficient',
  labelNames: ['sku'] as const,
});

export const orderCancellations = new client.Counter({
  name: 'order_cancellations_total',
  help: 'Customer cancellation requests by outcome',
  labelNames: ['outcome'] as const,
});

export const inventoryAvailable = new client.Gauge({
  name: 'inventory_available',
  help: 'Sellable units per SKU in the shop database',
  labelNames: ['sku'] as const,
});

export const checkoutQueueDepth = new client.Gauge({
  name: 'checkout_queue_depth',
  help: 'Visible messages in the checkout queue and its DLQ',
  labelNames: ['queue'] as const,
});

export const erpRequests = new client.Counter({
  name: 'erp_requests_total',
  help: 'ERP calls by operation and outcome',
  labelNames: ['operation', 'outcome'] as const,
});

export const erpRequestDuration = new client.Histogram({
  name: 'erp_request_duration_seconds',
  help: 'ERP call duration by operation and outcome',
  labelNames: ['operation', 'outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
});

export const orderProcessingDuration = new client.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time from order creation to a final status',
  labelNames: ['final_status'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900],
});

export type CheckoutOutcome = 'accepted' | 'out_of_stock' | 'duplicate' | 'invalid' | 'rate_limited' | 'shed';
export type CancelOutcome = 'cancelled' | 'already_cancelled' | 'not_cancellable' | 'not_found';
export type CacheResult = 'hit' | 'miss' | 'stale';
export type ErpOutcome = 'success' | 'error' | 'timeout' | 'client_error';

let defaultsStarted = false;

export function collectDefaultMetrics(prefix: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  client.collectDefaultMetrics({ prefix });
}
