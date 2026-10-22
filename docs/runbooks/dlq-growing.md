# Runbook — Messages in the DLQ

**Alert:** `MessagesInDLQ`

## Symptoms

`checkout_queue_depth{queue="dlq"} > 0`: orders failed invoicing 5 times.

## Diagnose

1. ElasticMQ UI (`localhost:9325`) or `GetQueueAttributes` on `checkout-orders-dlq`.
2. `SELECT id, status, attempts, last_error FROM orders WHERE status = 'FAILED' ORDER BY updated_at DESC;`
3. Check `order_events` for each order and the matching trace via `correlation_id`.

## Act

- Confirm the reservation was released (`inventory.reserved` decreased).
- **Before re-driving**, check the ERP: `GET /invoices?orderId=<id>`. If an invoice exists, mark the order
  `INVOICED` with that `erp_invoice_id` instead of retrying.
- Otherwise fix the root cause and move messages back to the main queue.
