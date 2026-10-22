---
name: new-endpoint
description: Add or change an HTTP endpoint end to end — Zod schema, route, service, metrics, tests and OpenAPI. Use whenever a route is created or its contract changes.
---

# New endpoint

1. **Contract first.** Write the request/response in `docs/openapi.yaml` (status codes, error schema,
   required headers such as `Idempotency-Key`).
2. **Schema.** Add Zod schemas to `src/modules/<domain>/schemas.ts` matching the OpenAPI entry.
3. **Service.** Implement the behavior in `service.ts`; throw `AppError(code, status)` for expected failures.
4. **Route.** In `routes.ts`, parse input with the schema, call the service, return the documented status.
   Use the route pattern (e.g. `/orders/:id/status`) — the metrics hook labels by it.
5. **Metrics.** Increment the contract metric for the outcome (e.g. `checkout_requests_total{outcome}`);
   never add high-cardinality labels.
6. **Tests.** Unit test for the service; integration test hitting the route with Fastify `inject`.
   Cover the error statuses, not only the happy path.
7. Run `npm run check && npm test`, then `make up` and `curl` the endpoint.
8. Commit: `feat(<domain>): add <METHOD> <path>`.
