---
paths:
  - "src/**"
  - "infra/prometheus/**"
  - "infra/otel/**"
---

# Observability

- `import '../observability/tracing'` is the first line of every entrypoint.
- Metric names, types and labels must match the README "Metrics contract" table exactly; alerts depend on them.
  Renaming a metric means updating `infra/prometheus/alerts.yml` in the same commit.
- Define metrics once in `src/shared/metrics.ts`; modules import them.
- No high-cardinality labels (`orderId`, `idempotencyKey`, user ids, raw URLs). `sku` is fine (bounded set).
  Use the Fastify route pattern (`/orders/:id/status`) for `route`, never the concrete path.
- Manual spans for business steps: `cache.get`, `stock.reserve`, `outbox.publish`, `erp.invoice`,
  `erp.lookup`. Set attributes like `sku`, `order.id`, `cache.result`.
- Logs are structured pino JSON with `orderId` and `correlationId`; never log full payloads with PII.
