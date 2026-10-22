# 0009 — Checkout peak protection: per-client rate limit and per-instance load shedding

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

`POST /checkout` had no admission control. In a flash sale every request went straight into a Postgres
transaction on a 20-connection pool. Measured with `tests/load/peak.js` on one API instance, the API process is
the first thing to saturate (~110% CPU at ~1,350 checkouts/s). Past that point latency grows without bound
(p95 1.4 s) and clients pile up. A single misbehaving client (a bot, a broken retry loop) could take the same
share of capacity as thousands of real shoppers.

## Decision

Two cheap gates, both **before any stock is touched**, so a rejected request has reserved nothing and a retry
with the same `Idempotency-Key` is always safe (ADR 0005):

1. **Rate limit per client IP** with `@fastify/rate-limit`, counters in Redis (shared by every instance),
   `CHECKOUT_RATE_LIMIT_MAX` per `CHECKOUT_RATE_LIMIT_WINDOW_S` (default 20 per 10 s). It runs on `onRequest`,
   before the body is parsed. Over budget → `429 RATE_LIMITED` with `Retry-After` and `x-ratelimit-*`.
   - The client is `req.ip`. `X-Forwarded-For` counts only with `TRUST_PROXY=true`, which must only be set behind
     a proxy that overwrites it; otherwise a client could rotate the header to dodge its budget (tested).
   - **Fails open:** if Redis errors the limit is skipped (`skipOnError`). Losing per-client fairness for a moment
     is better than refusing every checkout, and matches how the cache degrades.
2. **Concurrency limit per instance** with a short FIFO wait queue (a light "virtual queue"):
   `CHECKOUT_MAX_CONCURRENCY` checkouts run at once (default 16, below the pool's 20 so `/orders` and health keep
   connections); up to `CHECKOUT_MAX_QUEUE` wait for at most `CHECKOUT_QUEUE_TIMEOUT_MS`. Queue full or wait
   timed out → `503 OVERLOADED` with `Retry-After`. Validation runs first, so a bad request never takes a slot.
   Shed requests are counted, not logged, because a log line per shed request spends the CPU the shedding saves.

Observability: `checkout_requests_total{outcome="rate_limited"|"shed"}`, gauges `checkout_inflight` and
`checkout_queue_waiting`, alert `CheckoutLoadShedding` (> 20% rejected for 5 min).

## Consequences

- Above capacity the admitted requests keep a bounded p95 (135–248 ms instead of 1.4 s in the k6 runs). The
  excess gets an answer in ~10 ms with a retry hint instead of a slow timeout, and an abusive client is held to
  its budget.
- **Throughput of useful work drops when overloaded** (1,346 → 1,037 admitted/s at 2,500 offered; 1,404 → 668 at
  4,000). The API is CPU-bound and each rejection still costs CPU (Redis call, routing, a response). Real
  capacity comes from more instances. Rejecting at the edge (load balancer or CDN rate limit) is the next step.
- Below capacity the cap adds some queueing (p95 28 → 82 ms at 1,500/s) and sheds a little during bursts (0.5%).
  `CHECKOUT_MAX_CONCURRENCY` is the knob.
- Capacity is per instance: total = instances × `CHECKOUT_MAX_CONCURRENCY`, which must stay below what
  Postgres can serve.
- Users behind one NAT share a budget. That is acceptable for a guest checkout; with accounts, the key should be
  the user id.
- **Alternatives considered:**
  - A cluster-wide semaphore in Redis: an exact global cap, but a Redis round trip and a lease per request on
    the hot path, plus cleanup when a request crashes while holding a slot.
  - A real waiting room with tokens: the right tool for ticket-style drops, but more than a reservation that
    takes milliseconds needs.
  - Letting the Postgres pool queue requests (the previous behavior): every request waits, then they all time out
    together.
