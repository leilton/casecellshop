# 0008 — Export traces only when a collector is running

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

With only the core profile up (`make up`), about 1 in 5 cold `GET /products` returned `503` after exactly 2 s
(the ERP timeout), yet the ERP never logged those requests and the API had no TCP connection open to it.
Plain `fetch`, the ERP client in isolation and the client with OpenTelemetry loaded all worked.

Root cause: the OTLP exporter kept trying to reach `otel-collector`, which does not exist without the `obs`
profile. Each export resolves that host; the lookup takes ~10 s to fail, and Node's `dns.lookup` runs on the
4-thread libuv pool. Exports filled the pool, so the ERP's own lookup queued behind them until the request's
`AbortSignal.timeout` fired. It only showed when a new ERP connection was needed (after ~3 s idle).

## Decision

`src/observability/tracing.ts` registers the OTLP exporter only when `OTEL_TRACES_EXPORTER` is not `none`.
Compose defaults it to `none`; `make obs` sets `otlp`, when the collector exists. The SDK still creates spans
and propagates context, so trace ids keep appearing in logs and across the queue.

## Consequences

- 0 failures in 30 cold requests (was 5–6 in 30).
- Without `make obs` there is no trace UI, by design.
- Lesson recorded for production: a telemetry backend outage must not degrade the request path. Keep the
  exporter pointed at a local agent/collector (always resolvable), and consider `UV_THREADPOOL_SIZE` and DNS
  caching for services that do many lookups.
