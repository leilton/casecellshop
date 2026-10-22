# 0006 — Storefront cache: fresh/stale windows, single-flight and version sync

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

Every storefront hit used to call the ERP (300–500 ms, 5xx and hangs under load). The business wants lower
latency **without showing a wrong price or availability**. We cannot change the ERP, so it cannot push changes.

## Decision

- **Cache-aside in Redis**, one entry per data type: the ERP catalog (names and prices arrive in one payload,
  so the entry's freshness is bounded by price: `CACHE_TTL_PRICE_S`, 60 s) and our own availability
  (`CACHE_TTL_STOCK_S`, 5 s). Names change rarely, but splitting them into their own entry would double the
  ERP calls for no gain.
- **Fresh and stale windows.** Each entry stores `freshUntil`; Redis keeps it for fresh + `CACHE_STALE_IF_ERROR_S`.
  Past fresh we refresh; if the ERP fails we serve the previous value flagged as stale
  (`meta.stale`, `x-cache: stale`, `Cache-Control: no-store`, `cache_requests_total{result="stale"}`).
- **Single-flight** at two levels: concurrent misses in one process share one promise; across instances a
  Redis `SET NX PX` lock elects one refresher while the others serve the previous value or wait briefly.
  The lock is released only by its holder (compare-and-delete script).
- **Version sync for invalidation.** A worker job polls the ERP catalog every `CATALOG_SYNC_INTERVAL_MS` and,
  when a product's `version` increases, updates the read model (`products`, used for checkout prices) and
  evicts the cache entry. A price change is visible in about one sync interval instead of one TTL.
- **Availability is advisory.** The authoritative check is the reservation at checkout, so a 5 s-old stock
  figure cannot cause overselling.
- **Redis down degrades, not fails:** connection errors bypass the cache and go to the source.

## Consequences

- Warm `GET /products` p95 ≈ 5 ms with a ~99% hit ratio; ERP load drops to one call per TTL per key.
- A price may be up to one sync interval old; checkout always prices from the read model, never from the client.
- During an ERP outage customers see a copy at most `fresh + stale` seconds old, and we can measure how often.
- Alternatives considered: TTL-only (prices stale for a whole TTL, stampede on expiry), refresh-ahead on a
  timer for every key (ERP load even for cold products), CDC from the ERP's MySQL (best freshness, but more
  infrastructure than the challenge needs — the natural next step).
