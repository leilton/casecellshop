# 0005 — Idempotency at checkout and at invoicing

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

Clients double-click and retry; SQS redelivers; the ERP's `POST /invoices` is not idempotent, so a naive retry
after a timeout creates a duplicate invoice.

## Decision

- **Checkout:** require an `Idempotency-Key` header. `orders.idempotency_key` is UNIQUE and `request_hash`
  stores a hash of the payload. Same key → return the existing order; same key + different hash → `422`.
  Redis may short-circuit hot duplicates, but Postgres is the source of truth.
- **Invoicing:** before every retry, `GET /invoices?orderId=`. If an invoice exists, adopt it. The order row
  stores `erp_invoice_id`; a message for an already `INVOICED` order is acknowledged without calling the ERP.

## Consequences

- Double clicks return the same `orderId`; no duplicate invoices even under timeouts.
- One extra ERP read per retry — acceptable compared with a duplicate fiscal document.
