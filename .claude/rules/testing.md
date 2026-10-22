---
paths:
  - "tests/**"
  - "src/**/*.test.ts"
---

# Testing

- Vitest. Unit tests live next to the code: `src/modules/<domain>/<name>.test.ts`.
- Integration tests in `tests/integration/` run against the compose Postgres/Redis/SQS
  (`make up`, then `make test`). Each test cleans up the rows it creates.
- Unit-test services with in-memory fakes of repositories/clients; don't mock what you don't own deeply.
- Required coverage of the critical paths:
  - **Concurrency:** N parallel reservations on a SKU with stock S accept exactly `min(N, S)`.
  - **Idempotency:** same key → same `orderId`; same key + different body → `422`.
  - **Cache:** single-flight (one ERP call for N concurrent misses), stale-if-error, TTL per data type.
  - **Worker:** retry with lookup-before-retry never creates a second invoice; DLQ releases stock.
  - **Reservation properties:** `tests/integration/checkout.property.test.ts` (fast-check) must keep passing; a new
    stock-moving path (release, cancel, adjust) gets added to its generated commands.
- **Mutation testing:** `make mutation` (Stryker, `checkout` + `invoicing` only, ADR 0011). A change in those modules
  must not lower the score below `thresholds.break` in `stryker.config.json`. Kill new survivors with a test;
  `// Stryker disable next-line <mutator>: <reason>` only for equivalent or log-only mutants, always with a reason.
- Use the ERP mock admin API (`/admin/config`, `/admin/products/:sku`) to force failures — never `sleep` blindly.
- Load test (`tests/load/oversell.js`): ≤ initial stock accepted, double click returns the same `orderId`.
