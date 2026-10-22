# CaseCellShop — Senior Backend Technical Challenge

> Fictional company. 100% local environment: no cloud or Datadog account required.

## Stack

- **Node.js 22 + TypeScript** (the challenge's preferred stack), Fastify, Zod, Vitest
- **pino** (JSON logs), **prom-client** (metrics), **OpenTelemetry** (traces)
- Biome (lint + format), husky + commitlint (Conventional Commits), Git flow

## Services (Docker Compose)

| Service          | Image        | Port              | Role                                                                        |
| ---------------- | ------------ | ----------------- | --------------------------------------------------------------------------- |
| `api`            | local build  | 3000              | `GET /products`, `POST /checkout`, `GET /orders/{id}/status`, `/metrics`    |
| `worker`         | local build  | 9464 (`/metrics`) | Consumes the queue, invoices on the ERP, retry/DLQ, reconciliation          |
| `erp-mock`       | local build  | 4000              | Slow, unstable ERP (latency, 5xx, timeouts, non-idempotent invoicing)       |
| `postgres`       | postgres:16  | 5432              | **The shop's own database**: read model, stock/reservations, orders, outbox |
| `redis`          | redis:7      | 6379              | Storefront cache, idempotency, anti-stampede single-flight                  |
| `sqs`            | ElasticMQ    | 9324 / 9325 (UI)  | SQS-compatible `checkout-orders` queue + DLQ (redrive after 5 attempts)     |
| `otel-collector` | otel contrib | 4317/4318         | Telemetry pipeline — swap point for the Datadog exporter                    |
| `jaeger`         | jaeger       | 16686             | Distributed tracing UI                                                      |
| `prometheus`     | prometheus   | 9090              | Metrics + alert rules (`infra/prometheus/alerts.yml`)                       |
| `grafana`        | grafana      | 3001              | Dashboards (Datadog stand-in)                                               |
| `k6`             | grafana/k6   | —                 | Load test: race for one SKU + double click                                  |

Why ElasticMQ, Postgres and CommonJS: see the [ADRs](docs/adr/).

## Running

```bash
npm install                   # dev tools + git hooks (or run tools via ./scripts/npx.sh without host Node)
cp .env.example .env          # optional
make up                       # core
make obs                      # core + observability
curl localhost:3000/health    # should list postgres, redis, sqs, erp = ok
```

Without `make`: `docker compose up -d --build` and `docker compose --profile obs up -d --build`.

| URL                                | What                      |
| ---------------------------------- | ------------------------- |
| http://localhost:3000/health       | API and dependency health |
| http://localhost:4000/admin/config | ERP chaos (GET/POST)      |
| http://localhost:9325              | queue statistics          |
| http://localhost:16686             | traces (Jaeger)           |
| http://localhost:9090/alerts       | alerts (Prometheus)       |
| http://localhost:3001              | Grafana (no login)        |

### Simulating ERP failures

```bash
make chaos   # 30% errors + 20% timeouts → exercises retry, DLQ, stale-if-error
make calm    # back to normal
# change price/stock on the ERP to test cache invalidation:
curl -XPOST localhost:4000/admin/products/CASE-IPH15-BLK -H 'content-type: application/json' -d '{"priceCents":5990}'
```

The ERP's `POST /invoices` is **not idempotent** on purpose: a naive retry creates a duplicate invoice.
Use `GET /invoices?orderId=` before retrying (reconciliation).

### Load / overselling test

```bash
make reset && make up     # clean stock (CASE-IPH15-BLK = 10 units)
make load                 # 50 VUs, 200 checkouts on the same SKU, each with a double click
```

Pass criteria: at most 10 accepted orders (`checkout_accepted`), the rest `409`, and the double click returns
the same `orderId`.

## Documentation

| Where                                        | What                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | Components, checkout flow, order states, cache strategy |
| [docs/adr/](docs/adr/)                       | Architecture decision records                           |
| [docs/runbooks/](docs/runbooks/)             | What to do when each alert fires                        |
| [docs/openapi.yaml](docs/openapi.yaml)       | API contract                                            |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | Setup, Git flow, commit convention, PR checklist        |
| [CLAUDE.md](CLAUDE.md), [.claude/](.claude/) | AI assistant guidance: rules per path and skills        |
| [CHANGELOG.md](CHANGELOG.md)                 | Release history                                         |
| [PROMPTS.md](PROMPTS.md)                     | AI usage log                                            |

## Layout

```
src/
  api/server.ts               # PLACEHOLDER: /health and /metrics
  worker/index.ts             # PLACEHOLDER: /metrics and queue depth
  modules/<domain>/           # catalog | checkout | orders | invoicing (routes/service/repository/schemas)
  shared/                     # config, db, redis, sqs, logger, metrics, errors
  observability/tracing.ts    # OpenTelemetry (first import of every entrypoint)
erp-mock/server.mjs           # simulated ERP, no dependencies
infra/
  postgres/init.sql           # schema: products, inventory, orders, outbox, order_events + seed
  sqs/elasticmq.conf          # queue + DLQ
  otel/collector.yaml         # traces → Jaeger, spanmetrics → Prometheus (Datadog commented out)
  prometheus/{prometheus,alerts}.yml
  grafana/provisioning/       # datasources
tests/load/oversell.js        # k6
```

## Metrics contract

The alerts in `infra/prometheus/alerts.yml` already use these names. The implementation must expose them:

| Metric                                                | Type                | Labels                                              |
| ----------------------------------------------------- | ------------------- | --------------------------------------------------- |
| `http_request_duration_seconds`                       | histogram           | `route`, `method`, `status`                         |
| `cache_requests_total`                                | counter             | `cache`, `result` = hit/miss/stale                  |
| `checkout_requests_total`                             | counter             | `outcome` = accepted/out_of_stock/duplicate/invalid |
| `stock_reservation_conflicts_total`                   | counter             | `sku`                                               |
| `inventory_available`                                 | gauge               | `sku`                                               |
| `checkout_queue_depth`                                | gauge               | `queue` = main/dlq                                  |
| `erp_requests_total` / `erp_request_duration_seconds` | counter / histogram | `operation`, `outcome`                              |
| `order_processing_duration_seconds`                   | histogram           | `final_status`                                      |

## Next steps (implementation)

- [ ] `GET /products` with cache-aside, TTL per data type, single-flight and stale-if-error
- [ ] `POST /checkout`: `Idempotency-Key` → atomic reservation → order + outbox in the same transaction → `202`
- [ ] Outbox relay → queue
- [ ] Worker: ERP with timeout and backoff + jitter, lookup before retry, DLQ releases the reservation
- [ ] Reconciliation job (stuck orders, expired reservations)
- [ ] Complete `docs/openapi.yaml`, tests (concurrency, idempotency, cache, worker), `PROMPTS.md`
