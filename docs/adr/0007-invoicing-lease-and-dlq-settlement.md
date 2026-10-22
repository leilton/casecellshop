# 0007 — Invoicing lease, DLQ settlement and reconciliation

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

ADR 0005 makes retries safe by looking the invoice up before creating one. That covers *sequential* retries,
but SQS delivers at least once and can hand the same message to two consumers at the same time. Both would
look up, find nothing (the first `POST /invoices` has not returned yet) and both would create an invoice.
This was found by reasoning about at-least-once delivery while designing the tests, before any run showed it;
the integration test "two workers processing the same message concurrently" now guards it (exactly one invoice).

Separately, a message that exhausts its receives lands in the DLQ, and an order can lose its message
entirely (e.g. the relay published nothing before the reservation expired).

## Decision

- **Lease.** Starting an attempt sets `orders.invoicing_lease_until = now() + INVOICING_LEASE_S` under a row
  lock. While the lease is held, another delivery gets `busy` and re-queues itself with a delay instead of
  calling the ERP. The lease is cleared when the attempt records success, failure or a retryable error, so
  normal retries are not slowed down. If the worker dies mid-call, the lease simply expires (15 s, longer
  than `ERP_TIMEOUT_MS`) and the next delivery proceeds — with a lookup first, since `attempts > 1`.
- **DLQ settlement.** The worker consumes the DLQ: it looks the invoice up once more and settles the order as
  `INVOICED` (if the ERP has it) or `FAILED`, releasing the reservation in the same transaction. If the ERP is
  down for the lookup, the message stays in the DLQ (alert `MessagesInDLQ`).
- **Reconciliation.** Every `RECONCILE_INTERVAL_MS`: `RESERVED` orders past `reserved_until` with no invoice in
  the ERP are `CANCELLED` and their stock released; `INVOICING` orders with no activity for
  `INVOICING_STUCK_AFTER_S` are looked up and adopted if invoiced (otherwise their message will retry or reach
  the DLQ). An invoice found in the ERP always wins over our state: the ERP is the fiscal source of truth.

## Consequences

- No duplicate invoices under sequential retries, concurrent duplicate deliveries or crashes mid-call.
- Every order ends in `INVOICED`, `FAILED` or `CANCELLED`; reserved stock never leaks.
- A duplicate delivery may wait up to the lease before it is dropped as a no-op.
- `FAILED` orders are an alert (`OrdersFailingInvoicing`), not a silent queue: the DLQ only stays non-empty when
  the settlement itself is blocked.
- Schema change: `orders.invoicing_lease_until` (`make reset`).
