# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Swagger UI at `GET /docs`, rendered from `docs/openapi.yaml` (`@fastify/swagger` in static mode +
  `@fastify/swagger-ui`, assets bundled, works offline). `/docs/json` and `/docs/yaml` return the parsed contract.

### Changed

- `GET /openapi.yaml` is served as `text/plain` so browsers display it instead of downloading it.
- The production image now includes `docs/openapi.yaml` (it was missing, so `/openapi.yaml` would have been `404`).

## [0.2.2] - 2026-10-22

### Documentation

- README and PROMPTS.md state the current test count (156) instead of the count from before 0.2.1.

## [0.2.1] - 2026-10-22

### Fixed

- The `incoming request` log line now carries `correlationId`: the correlation context is created in the HTTP
  server factory, before Fastify logs it. Removes the Fastify `disableRequestLogging` deprecation warning.

### Changed

- `RESERVATION_TTL_S`, `CATALOG_SYNC_INTERVAL_MS`, `RECONCILE_INTERVAL_MS`, `INVOICING_STUCK_AFTER_S` and
  `INVOICING_LEASE_S` are listed in `.env.example` and passed through `docker-compose.yml`.

### Documentation

- PROMPTS.md, ADR 0007 and the README now say which problems were observed when running the system and which
  were caught in review while designing the tests; PROMPTS.md has an audit row and a note on how rows 4–7 ran.

## [0.2.0] - 2026-10-22

### Added

- Shared foundation: Zod-validated config, pino logger with correlation context, metrics registry (README
  contract), span helpers with trace-context propagation, Postgres transaction helper, Redis/SQS clients and
  an ERP HTTP client with mandatory timeout, error classification and ERP metrics.
- `GET /products`: cache-aside in Redis with fresh/stale windows, single-flight (in-process + Redis lock),
  stale-if-error and `x-cache`; ERP catalog sync by `version` that updates the read model and evicts the cache.
- `POST /checkout`: `Idempotency-Key`, atomic conditional reservation, order + event + outbox in one
  transaction, server-side prices, `202` with `Location`.
- `GET /orders/{orderId}/status` with the full status history.
- Error contract `{ error: { code, message, details? } }` with stable codes (400/404/409/415/422/500/503) and
  `docs/openapi.yaml` documenting every route and status.
- Worker: outbox relay (`SKIP LOCKED`), SQS consumer with backoff + full jitter, lookup-before-retry, an
  invoicing lease against concurrent duplicate deliveries, DLQ handler (FAILED + stock released) and a
  reconciliation job (expired reservations, stuck invoicing).
- Grafana dashboard provisioned from `infra/grafana/provisioning/dashboards`; alerts for failed invoicing,
  expiring reservations and slow invoicing.
- 153 tests (unit + integration against Postgres/Redis/SQS) with an HTTP status matrix, an OpenAPI contract
  check and an 80% coverage gate; integration tests use an isolated `shop_test` database.

### Changed

- Schema: `orders.invoicing_lease_until` (run `make reset`).
- `CACHE_TTL_CATALOG_S` removed: names and prices arrive together from the ERP and share the price TTL.
- `npm run build` uses `tsconfig.build.json`; `tsconfig.json` type-checks source and tests.

### Fixed

- Intermittent 2 s `503` on `GET /products`: exporting traces to a missing collector starved the libuv
  threadpool with slow DNS lookups. Traces are exported only when `OTEL_TRACES_EXPORTER=otlp` (`make obs`).
- `text/plain` bodies now get `415` instead of being parsed as a string.
- A Redis client that is still connecting is treated as unavailable (cache bypass) instead of a `500`.
- k6 load test treats `409` as an expected response.

### Documentation

- README rewritten for the delivery: quick start, API and error codes, how it works, decisions and trade-offs,
  observability (logs, metrics, traces, SLOs, alerts, dashboard, Datadog mapping), tests, measured
  verification results, simplifications and limitations.
- ADRs 0006 (storefront cache), 0007 (invoicing lease, DLQ settlement, reconciliation), 0008 (trace export).
- DLQ runbook updated for automatic dead-letter settlement; architecture flow and order states updated.
- `PROMPTS.md` entries 3–7.

## [0.1.0] - 2026-10-22

### Added

- Local environment: Docker Compose with API/worker placeholders, ERP mock, Postgres, Redis, ElasticMQ,
  OpenTelemetry Collector, Jaeger, Prometheus, Grafana and k6.
- Postgres schema (products, inventory, orders, outbox, order_events) and seed.
- Prometheus alert rules and metrics contract.
- Project conventions: CLAUDE.md, Claude rules and skills, CONTRIBUTING.md (Git flow), ADRs, runbooks,
  Biome, husky and commitlint.
