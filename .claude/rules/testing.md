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
- Use the ERP mock admin API (`/admin/config`, `/admin/products/:sku`) to force failures — never `sleep` blindly.
- Load test (`tests/load/oversell.js`): ≤ initial stock accepted, double click returns the same `orderId`.
