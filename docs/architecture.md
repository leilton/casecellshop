# Architecture

## Context

CaseCellShop sells phone cases. Product, price and stock live in a legacy ERP (read-only MySQL behind an HTTP
API) that is slow, unstable and whose invoicing endpoint is **not idempotent**. Peak traffic must not
overload the ERP, oversell stock or create duplicate invoices.

## Components

| Component                                      | Responsibility                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `api`                                          | `GET /products` (cached), `POST /checkout` (reserve + enqueue), `GET /orders/:id/status`, `/metrics` |
| `worker`                                       | Outbox relay → SQS, SQS consumer → ERP invoicing with retry/lookup, DLQ handling, reconciliation     |
| Postgres                                       | Shop-owned data: storefront read model, inventory/reservations, orders, outbox, order events         |
| Redis                                          | Storefront cache and single-flight locks (idempotency lives in Postgres, ADR 0005)                   |
| SQS (ElasticMQ)                                | `checkout-orders` queue + `checkout-orders-dlq` (redrive after 5 receives)                           |
| ERP mock                                       | Simulates latency, 5xx, timeouts and non-idempotent invoicing                                        |
| OTel Collector → Jaeger / Prometheus / Grafana | Traces, metrics, alerts (Datadog stand-in)                                                           |

## Checkout flow

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant P as Postgres
  participant W as Worker
  participant Q as SQS
  participant E as ERP
  C->>A: POST /checkout (Idempotency-Key)
  A->>P: BEGIN; insert order (unique key)
  A->>P: UPDATE inventory ... WHERE available >= q
  A->>P: insert outbox + order_event; COMMIT
  A-->>C: 202 { orderId, status: RESERVED }
  W->>P: outbox rows FOR UPDATE SKIP LOCKED
  W->>Q: SendMessage(orderId)
  W->>P: set published_at
  Q->>W: ReceiveMessage
  W->>P: take invoicing lease (concurrent duplicate delivery backs off)
  W->>E: GET /invoices?orderId= (attempt > 1: already invoiced?)
  alt not invoiced
    W->>E: POST /invoices (timeout, backoff + jitter)
  end
  W->>P: status INVOICED + order_event; COMMIT
  W->>Q: DeleteMessage
  Note over Q,W: retryable failure → ChangeMessageVisibility (backoff + full jitter)
  Note over Q,W: after 5 receives → DLQ → worker looks up once more → INVOICED, or FAILED + stock released
```

## Order states

```mermaid
stateDiagram-v2
  [*] --> RESERVED: stock reserved
  RESERVED --> INVOICING: worker picks message (lease)
  INVOICING --> INVOICED: ERP invoice created or adopted
  INVOICING --> INVOICING: retry (lookup first)
  INVOICING --> FAILED: DLQ settlement or ERP 4xx — stock released
  RESERVED --> CANCELLED: reservation expired without invoice (reconciliation) — stock released
  FAILED --> [*]
  INVOICED --> [*]
  CANCELLED --> [*]
```

## Storefront cache

- Cache-aside in Redis with TTL per data type: the ERP catalog entry (names + prices arrive together, so its
  freshness is bounded by price) `60s`, our stock `5s` (`CACHE_TTL_PRICE_S`, `CACHE_TTL_STOCK_S`).
- **Single-flight:** on a miss, one request takes a short Redis lock and refreshes; others wait briefly or
  get the previous value — prevents a stampede on the ERP.
- **Stale-if-error:** if the ERP fails, serve the last value for up to `CACHE_STALE_IF_ERROR_S` and count
  `cache_requests_total{result="stale"}`.
- Displayed stock is advisory; the authoritative check is the reservation in Postgres.
- **Invalidation:** the worker polls the ERP catalog every `CATALOG_SYNC_INTERVAL_MS`; a higher `version` updates
  the read model (checkout prices) and evicts the cache entry ([ADR 0006](adr/0006-storefront-cache.md)).

## Reconciliation

Every `RECONCILE_INTERVAL_MS` the worker re-checks against the ERP: expired `RESERVED` orders with no invoice
are cancelled and their stock released; `INVOICING` orders idle for `INVOICING_STUCK_AFTER_S` adopt the ERP
invoice if one exists ([ADR 0007](adr/0007-invoicing-lease-and-dlq-settlement.md)).

## Decisions

See [`adr/`](adr/). Operational procedures in [`runbooks/`](runbooks/).
