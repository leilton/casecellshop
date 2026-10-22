---
name: verify
description: Verify the project end to end — lint, types, unit tests, the running stack, health check and optionally the overselling load test. Use before opening a PR or after a change to checkout, cache or worker.
---

# Verify

Run in order and stop at the first failure, reporting the output:
1. `npm run check` (or `./scripts/npx.sh biome check . && ./scripts/npx.sh tsc --noEmit` without host Node).
2. `npm test`.
3. `make up` and wait for containers: `docker compose ps`.
4. `curl -s localhost:3000/health` → every dependency must be `ok`.
5. `curl -s localhost:3000/metrics | grep -E 'checkout_requests_total|cache_requests_total'` once those exist.
6. **Only if checkout/inventory changed:** `make reset && make up && make load`, then check
   - `checkout_accepted` ≤ 10 (initial stock of `CASE-IPH15-BLK`),
   - the check "double click returns the same orderId" is 100%.
7. **Only if worker/ERP code changed:** `make chaos`, create a few orders, confirm each reaches `INVOICED` or
   `FAILED` and `GET localhost:4000/invoices?orderId=<id>` returns at most one invoice; then `make calm`.

Report what passed, what failed (with output) and what was skipped.
