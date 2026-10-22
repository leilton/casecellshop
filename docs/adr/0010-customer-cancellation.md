# 0010 — Customer cancellation while RESERVED

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

A buyer who changes their mind had no way out: their units stayed reserved until the reservation expired
(`RESERVATION_TTL_S`, 15 min) and the reconciler cancelled the order. During a flash sale those are units nobody
else can buy. A cancel must not break the invariants: it must not release stock twice, and it must never race the
worker into an order that is both cancelled and invoiced in the ERP (whose `POST /invoices` is not idempotent).

## Decision

`POST /orders/{id}/cancel`, owned by the `orders` module:

- **Only from `RESERVED`.** In one transaction: `SELECT … FOR UPDATE` on the order, release each item in sorted SKU
  order (`available += q, reserved -= q WHERE reserved >= q`), set `CANCELLED`, write the `order_events` row with
  `{ reason: "cancelled by customer", released: true }`.
- **The row lock is the whole concurrency story.** The worker's `startAttempt` takes the same lock and moves the
  order to `INVOICING` *before* it calls the ERP. Either the cancel commits first, and the worker then sees a terminal
  status and acks the message without an ERP call, or the worker commits first and the cancel gets
  `409 ORDER_NOT_CANCELLABLE` with `details.status`. No new column, no message to recall from SQS.
- **Idempotent by state, not by key.** An order that is already `CANCELLED` (by the customer or by expiry) answers
  `200` with its current status and touches nothing. A retry or double click is safe without an `Idempotency-Key`.
- The response is the same body as `GET /orders/{id}/status`, `Cache-Control: no-store`.
- The release SQL mirrors invoicing's `releaseReservation` instead of importing it: a module never imports another
  module's repository.
- Counted in `order_cancellations_total{outcome}`. No alert: cancels are a business signal, not a failure.

## Consequences

- Units return to the shelf in milliseconds instead of up to 15 minutes.
- Once invoicing has started the order cannot be cancelled here. That needs a refund/credit-note flow with the
  ERP, which is out of scope.
- There is no authentication in this challenge: the order UUID is the only capability. A real shop must check that
  the caller owns the order.
- Two copies of the release SQL (orders and invoicing). Both are covered by integration tests that assert
  `available + reserved` is conserved, and by the reservation property test.
