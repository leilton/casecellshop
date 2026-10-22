# Runbook — Failed invoicing and the DLQ

**Alerts:** `OrdersFailingInvoicing`, `MessagesInDLQ`, `ReservationsExpiring`

## How it normally works

A message that fails 5 receives is redriven to `checkout-orders-dlq`. The worker consumes the DLQ, looks the
invoice up in the ERP once more and settles the order: `INVOICED` if the ERP has the invoice, otherwise
`FAILED` with the reservation released. So:

- `OrdersFailingInvoicing` — orders reached `FAILED`: customers did not get their purchase. Investigate why.
- `MessagesInDLQ` — messages are **staying** in the DLQ: the settlement itself is blocked (usually the ERP
  lookup is failing). Stock is still reserved for those orders.
- `ReservationsExpiring` — reconciliation is cancelling `RESERVED` orders that never reached the worker:
  the outbox relay or the queue is not moving.

## Diagnose

1. Grafana "Orders reaching a final status" and "ERP calls by operation and outcome".
2. Recent failures and why:
   ```sql
   SELECT id, status, attempts, last_error, correlation_id, updated_at
   FROM orders WHERE status IN ('FAILED', 'CANCELLED') ORDER BY updated_at DESC LIMIT 20;
   ```
3. Full history of one order: `GET /orders/<id>/status` (or `order_events`), then its trace in Jaeger by
   `correlation_id` / `trace_id` in the worker logs (`order.process`, `erp.invoice`, `order.dead_letter`).
4. DLQ depth: ElasticMQ UI (`localhost:9325`) or `checkout_queue_depth{queue="dlq"}`.
5. Relay backlog (for `ReservationsExpiring`): `SELECT count(*) FROM outbox WHERE published_at IS NULL;`

## Act

- **ERP rejecting invoices (`client_error`)**: a data problem (SKU, payload). Fix it, then create a new order for
  the customer; do not re-drive a rejected payload.
- **ERP down (`error`/`timeout`)**: follow [erp-degraded](erp-degraded.md). Messages left in the DLQ are settled
  automatically once the ERP answers the lookup.
- **Never re-drive or re-invoice without checking the ERP first**: `GET /invoices?orderId=<id>`. If an invoice
  exists, the order must become `INVOICED` with that `erp_invoice_id` — the worker does this by itself when it
  sees the order again; re-driving the message (ElasticMQ UI → move to `checkout-orders`) is safe because the
  consumer looks up before creating.
- **Relay stuck**: check worker logs for `outbox-relay` errors and SQS reachability; the rows stay in `outbox`
  and are published once it recovers.
- After the fix, confirm `inventory.reserved` went back to the expected value for the affected SKUs.
