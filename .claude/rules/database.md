---
paths:
  - "src/**/repository.ts"
  - "src/shared/db.ts"
  - "infra/postgres/**"
---

# Database (Postgres)

- Parameterized queries only (`$1, $2`). Never interpolate values into SQL strings.
- Stock reservation is ONLY this pattern — no read-then-write:

  ```sql
  UPDATE inventory SET available = available - $2, reserved = reserved + $2, updated_at = now()
  WHERE sku = $1 AND available >= $2 RETURNING available;
  ```

  Zero rows → out of stock (`409`) and increment `stock_reservation_conflicts_total{sku}`.
- Multi-item orders: reserve SKUs in a stable order (sorted by `sku`) inside one transaction to avoid deadlocks.
- Order row + `outbox` row + `order_events` row are written in the SAME transaction.
- Every status transition writes an `order_events` row (`from_status`, `to_status`, `detail`).
- Idempotency is enforced by the `orders.idempotency_key` UNIQUE constraint; handle `23505` by returning the
  existing order (or `422` if `request_hash` differs).
- Always release the client (`try/finally`) and `ROLLBACK` on error.
- Schema changes go in `infra/postgres/init.sql` (no migration tool yet); note in the PR that `make reset` is required.
