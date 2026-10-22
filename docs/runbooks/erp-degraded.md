# Runbook — ERP degraded

**Alerts:** `ErpHighErrorRate`, `CacheServingStale`, `CheckoutQueueBacklog`

## Symptoms

- `erp_requests_total{outcome!="success"}` above 5%; `cache_requests_total{result="stale"}` > 0.
- `checkout_queue_depth{queue="main"}` growing.

## Diagnose

1. Grafana/Prometheus: ERP error rate and `erp_request_duration_seconds` p95 by `operation`.
2. Jaeger: filter `service=casecellshop-worker`, span `erp.invoice` — timeouts vs 5xx.
3. `curl localhost:4000/admin/config` locally to see injected chaos.

## Act

- Storefront keeps serving stale data — no action needed while within `CACHE_STALE_IF_ERROR_S`.
- If the backlog keeps growing, lower `WORKER_CONCURRENCY` to avoid hammering the ERP.
- Once the ERP recovers, confirm the backlog drains and the reconciliation job clears `INVOICING` orders.
