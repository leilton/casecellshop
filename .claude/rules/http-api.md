---
paths:
  - "src/api/**"
  - "src/modules/**/routes.ts"
  - "src/modules/**/schemas.ts"
  - "docs/openapi.yaml"
---

# HTTP API

- Every route is a Fastify plugin in `src/modules/<domain>/routes.ts`, registered in `src/api/server.ts`.
- Validate params, query, headers and body with the Zod schemas in `schemas.ts`. Never trust raw input.
- Routes do HTTP only: parse → call service → map result to status. No SQL, no business rules.
- Status contract:
  - `GET /products` → `200` (may be served stale; set `x-cache: hit|miss|stale`).
  - `POST /checkout` → `202 { orderId, status }`; `400` invalid payload or missing `Idempotency-Key`;
    `409` out of stock; `422` same `Idempotency-Key` with a different payload; `429 RATE_LIMITED` per client
    IP and `503 OVERLOADED` at instance capacity, both with `Retry-After` and before any stock is touched.
  - `GET /orders/:id/status` → `200` / `404`.
- Errors are always `{ "error": { "code": "OUT_OF_STOCK", "message": "..." } }` via `AppError`.
- Propagate `x-correlation-id` (generate one if absent) into logs, outbox payload and ERP calls.
- Any route change must be reflected in `docs/openapi.yaml` in the same commit.
