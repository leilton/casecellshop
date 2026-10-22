---
paths:
  - "src/worker/**"
  - "src/modules/invoicing/**"
  - "src/shared/sqs.ts"
  - "infra/sqs/**"
---

# Worker, queue and ERP

- Delivery is at-least-once: every handler must be idempotent (a message may arrive twice or concurrently).
- Every ERP call has a timeout (`ERP_TIMEOUT_MS`, via `AbortSignal.timeout`). No call without one.
- Retries use exponential backoff with full jitter, capped by `WORKER_MAX_ATTEMPTS`.
- **Before retrying `POST /invoices`, call `GET /invoices?orderId=`**. If an invoice exists, adopt its
  `invoiceId` instead of creating another one. This is the duplicate-invoice guard.
- Delete the SQS message only AFTER the order update is committed. On failure, don't delete — let the
  visibility timeout and redrive (`maxReceiveCount = 5`) move it to the DLQ.
- A message that reaches the DLQ marks the order `FAILED` and releases its reservation
  (`available += q, reserved -= q`) in one transaction.
- Outbox relay: select unpublished rows with `FOR UPDATE SKIP LOCKED`, publish, then set `published_at`.
- Reconciliation job: orders stuck in `INVOICING` / expired `reserved_until` are re-checked against the ERP.
- Record `erp_requests_total` / `erp_request_duration_seconds` with `operation` and `outcome`.
