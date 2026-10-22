# Runbook — Slow storefront

**Alerts:** `StorefrontHighLatency`, `CacheHitRatioLow`

## Symptoms

`GET /products` p95 above 300 ms or cache hit ratio below 80%.

## Diagnose

1. `cache_requests_total` by `result`: many `miss` means TTLs too short or keys being evicted.
2. Redis `INFO memory` / `evicted_keys` (maxmemory is 128 MB with LRU).
3. Jaeger: span `cache.get` vs ERP spans inside `GET /products`.

## Act

- Check that single-flight is working (one ERP call per key per refresh).
- Tune `CACHE_TTL_*` per data type; raise Redis memory if evictions are high.
