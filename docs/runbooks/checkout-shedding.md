# Runbook — Checkout load shedding

**Alert:** `CheckoutLoadShedding`

## Symptoms

More than 20% of `POST /checkout` answered `429 RATE_LIMITED` or `503 OVERLOADED` for 5 minutes. Nothing is
reserved for those requests; clients are told to retry after `Retry-After` with the same `Idempotency-Key`.

## Diagnose

1. `checkout_requests_total` by `outcome`: `rate_limited` (per-client budget) vs `shed` (instance capacity).
2. Mostly `rate_limited`: a few clients (bots, a broken retry loop) or many users behind one NAT. Check the API
   logs for the 429 lines; with `TRUST_PROXY=false` behind a load balancer every user shares the proxy's IP.
3. Mostly `shed`: `checkout_inflight` pinned at `CHECKOUT_MAX_CONCURRENCY` and `checkout_queue_waiting` high.
   Check `http_request_duration_seconds{route="/checkout"}` and Postgres (locks on `inventory`, slow queries):
   slow transactions hold slots longer.

## Act

- Genuine peak: scale API instances (capacity is per instance) while keeping
  `instances × CHECKOUT_MAX_CONCURRENCY` below what Postgres can serve.
- Abusive client: keep the limit; block upstream if it persists.
- Shared IP (NAT, missing proxy trust): set `TRUST_PROXY=true` only behind a proxy that overwrites
  `X-Forwarded-For`, or raise `CHECKOUT_RATE_LIMIT_MAX`.
- Postgres slow: see [suspected overselling](suspected-oversell.md) for inventory lock contention; do not raise
  `CHECKOUT_MAX_CONCURRENCY` above the pool size (20), it only moves the wait into the pool.
